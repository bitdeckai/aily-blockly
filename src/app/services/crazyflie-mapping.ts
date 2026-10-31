import { MathUtils, Vector3 } from 'three';
import { AttitudeSample, attitudeQuaternion, FlightPoseSample, isFlightPoseSample, relativeFlightPose } from './crazyflie-attitude';

export const RANGE_DIRECTIONS = ['front', 'back', 'left', 'right', 'up'] as const;
export type RangeDirection = typeof RANGE_DIRECTIONS[number];
export type MappingSource = 'simulation' | 'hardware';
export interface MappingPose { x: number; y: number; z: number; yaw: number; }
export interface MappingSample extends FlightPoseSample {
  epoch: number;
  poseTimestampMs: number;
  ranges: Record<RangeDirection, number | null>;
}
export type MappingEvent = MappingSample | { type: 'error'; message: string }
  | { type: 'reference' } | { type: 'stopped' };
export interface MappingVoxel { x: number; y: number; z: number; hits: number; }
export interface MappingCell { x: number; z: number; occupied: boolean; observations: number; }
export const RANGE_VECTORS: Record<RangeDirection, Vector3> = {
  front: new Vector3(-1, 0, 0), back: new Vector3(1, 0, 0),
  left: new Vector3(0, 0, 1), right: new Vector3(0, 0, -1), up: new Vector3(0, 1, 0),
};

export function firmwareTimeDifference(a: number, b: number): number {
  return ((a - b + 0x800000) % 0x1000000 + 0x1000000) % 0x1000000 - 0x800000;
}

export function isMappingSample(value: unknown): value is MappingSample {
  if (!isFlightPoseSample(value) || !('epoch' in value) || typeof value.epoch !== 'number'
    || !Number.isInteger(value.epoch) || value.epoch < 0
    || !('poseTimestampMs' in value) || typeof value.poseTimestampMs !== 'number'
    || ![value.timestampMs, value.poseTimestampMs].every(time => Number.isInteger(time) && time >= 0 && time <= 0xffffff)
    || Math.abs(firmwareTimeDifference(value.timestampMs, value.poseTimestampMs)) > 50
    || !('ranges' in value) || typeof value.ranges !== 'object' || value.ranges === null) return false;
  const ranges = value.ranges;
  return RANGE_DIRECTIONS.every(direction => {
    if (!(direction in ranges)) return false;
    const distance: unknown = Reflect.get(ranges, direction);
    return distance === null || (typeof distance === 'number' && Number.isFinite(distance) && distance > 0 && distance < 4);
  });
}

export class RangeVoxelMap {
  readonly resolution = 0.1;
  readonly maximumVoxels = 20000;
  readonly maximumCells = 20000;
  readonly voxels = new Map<string, MappingVoxel>();
  readonly cells = new Map<string, MappingCell>();
  source: MappingSource | null = null;
  active = false;
  invalidated = false;
  samples = 0;
  pose: MappingPose | null = null;
  attitude: AttitudeSample | null = null;
  private reference: MappingSample | null = null;
  private anchor: MappingPose = { x: 0, y: 0, z: 0, yaw: 0 };
  private lastTimestamp: number | null = null;

  start(source: MappingSource, anchor: MappingPose): void {
    if (this.source !== null && this.source !== source) throw new Error('请先清空地图，再切换模拟/真机数据源');
    if (this.invalidated) throw new Error('定位参考点已改变，请先清空地图再继续');
    if (this.source === null) {
      this.source = source;
      this.anchor = { ...anchor };
    }
    this.active = true;
  }

  pause(): void { this.active = false; }

  invalidate(): void {
    this.active = false;
    this.invalidated = true;
  }

  clear(): void {
    this.voxels.clear();
    this.cells.clear();
    this.source = null;
    this.active = false;
    this.invalidated = false;
    this.samples = 0;
    this.pose = null;
    this.attitude = null;
    this.reference = null;
    this.lastTimestamp = null;
  }

  receive(value: unknown): boolean {
    if (!isMappingSample(value)) throw new Error('建图数据无效，或位置与测距时间差超过 50 ms');
    if (!this.active) return false;
    if (this.reference && value.epoch !== this.reference.epoch) {
      this.invalidate();
      throw new Error('定位参考点已重置，已暂停建图；请清空地图后继续');
    }
    if (this.lastTimestamp !== null && firmwareTimeDifference(value.timestampMs, this.lastTimestamp) <= 0) return false;
    this.reference ??= { ...value };
    const pose = this.source === 'hardware' ? relativeFlightPose(value, this.reference, this.anchor)
      : { x: -value.x, y: value.z, z: value.y, yaw: MathUtils.degToRad(value.yaw) };
    if (![pose.x, pose.y, pose.z, pose.yaw].every(Number.isFinite)
      || Math.max(Math.abs(pose.x), Math.abs(pose.y), Math.abs(pose.z)) > 50) {
      this.pause();
      throw new Error('测距点超出 ±50 m 实验建图范围，请检查定位与单位');
    }
    const rotation = attitudeQuaternion(value.roll, value.pitch, MathUtils.radToDeg(pose.yaw));
    const candidates = new Map<string, MappingVoxel>();
    const cells = new Map<string, MappingCell>();
    for (const direction of RANGE_DIRECTIONS) {
      const distance = value.ranges[direction];
      if (distance === null) continue;
      const beam = RANGE_VECTORS[direction].clone().applyQuaternion(rotation);
      const endpoint = beam.clone().multiplyScalar(distance)
        .add(new Vector3(pose.x, pose.y, pose.z));
      if (Math.max(Math.abs(endpoint.x), Math.abs(endpoint.y), Math.abs(endpoint.z)) > 50) {
        this.pause();
        throw new Error('测距点超出 ±50 m 实验建图范围，请检查定位与单位');
      }
      const indices = endpoint.toArray().map(coordinate => Math.round(coordinate / this.resolution));
      candidates.set(indices.join(','), {
        x: indices[0] * this.resolution, y: indices[1] * this.resolution, z: indices[2] * this.resolution, hits: 1,
      });
      // Vertical/tilted beams can hit floors or ceilings, not planar walls.
      if (direction === 'up' || Math.abs(beam.y) > Math.sin(MathUtils.degToRad(10))) continue;
      let x = Math.round(pose.x / this.resolution), z = Math.round(pose.z / this.resolution);
      const endX = indices[0], endZ = indices[2];
      const dx = Math.abs(endX - x), dz = Math.abs(endZ - z);
      const sx = x < endX ? 1 : -1, sz = z < endZ ? 1 : -1;
      let error = dx - dz;
      while (true) {
        const key = `${x},${z}`;
        const occupied = x === endX && z === endZ;
        cells.set(key, { x: x * this.resolution, z: z * this.resolution,
          occupied: occupied || cells.get(key)?.occupied === true, observations: 1 });
        if (occupied) break;
        const twice = 2 * error;
        if (twice > -dz) { error -= dz; x += sx; }
        if (twice < dx) { error += dx; z += sz; }
      }
    }
    const additions = Array.from(candidates.keys()).filter(key => !this.voxels.has(key)).length;
    if (this.voxels.size + additions > this.maximumVoxels) {
      this.pause();
      throw new Error('已达到 20000 个体素上限，请导出或清空地图');
    }
    const cellAdditions = Array.from(cells.keys()).filter(key => !this.cells.has(key)).length;
    if (this.cells.size + cellAdditions > this.maximumCells) {
      this.pause();
      throw new Error('已达到 20000 个二维栅格上限，请导出或清空地图');
    }
    for (const [key, point] of candidates) {
      const existing = this.voxels.get(key);
      if (existing) existing.hits++;
      else this.voxels.set(key, point);
    }
    for (const [key, cell] of cells) {
      const existing = this.cells.get(key);
      if (existing) {
        existing.observations++;
        existing.occupied = existing.occupied || cell.occupied;
      } else this.cells.set(key, cell);
    }
    this.lastTimestamp = value.timestampMs;
    this.samples++;
    this.pose = pose;
    this.attitude = { type: 'sample', timestampMs: value.timestampMs,
      roll: value.roll, pitch: value.pitch, yaw: MathUtils.radToDeg(pose.yaw) };
    return true;
  }

  exportData() {
    return {
      format: 'robotstem-range-voxel-map', version: 1, createdAt: new Date().toISOString(),
      source: this.source, voxelSizeM: this.resolution, samples: this.samples,
      coordinateFrame: 'X forward, Y left, Z up; metres',
      reference: this.reference, sceneAnchor: this.anchor, invalidated: this.invalidated,
      limitations: ['Known-pose mapping, not SLAM', 'Free cells only reflect measured horizontal rays at sensor height; no collision-safety guarantee',
        'Five sparse range beams; positioning drift is not corrected'],
      voxels: Array.from(this.voxels.values(), point => ({ x: -point.x, y: point.z, z: point.y, hits: point.hits })),
      occupancy: {
        format: 'robotstem-range-occupancy-grid', version: 1, resolutionM: this.resolution,
        coordinateFrame: 'X forward, Y left; cell centres in metres; height projected',
        occupiedValue: 100, freeValue: 0, unknownValue: -1,
        unknownCells: 'Cells absent from the sparse list are unknown, not free',
        limitations: ['Only four horizontal beams within 10 degrees of the horizontal plane',
          'Invalid and out-of-range readings do not clear space',
          'Occupied cells persist until clear; different heights are projected, not volumetric clearance'],
        cells: Array.from(this.cells.values(), cell => ({
          x: -cell.x, y: cell.z, value: cell.occupied ? 100 : 0, observations: cell.observations,
        })),
      },
    };
  }
}

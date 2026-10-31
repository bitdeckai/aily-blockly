import {
  Box3, BoxGeometry, BufferGeometry, EdgesGeometry, Float32BufferAttribute, Group,
  LineBasicMaterial, LineSegments, Points, PointsMaterial, Ray, Vector3,
} from 'three';
import { attitudeQuaternion } from './crazyflie-attitude';
import { MappingPose, MappingSample, RANGE_DIRECTIONS, RANGE_VECTORS, RangeVoxelMap } from './crazyflie-mapping';

const DEMO_BOXES = [
  { center: [-2, 1, 0], size: [0.08, 2, 4.08] },
  { center: [2, 1, 0], size: [0.08, 2, 4.08] },
  { center: [0, 1, -2], size: [4.08, 2, 0.08] },
  { center: [0, 1, 2], size: [4.08, 2, 0.08] },
  { center: [0, 2, 0], size: [4.08, 0.08, 4.08] },
  { center: [-0.9, 0.3, 0.75], size: [0.4, 0.6, 0.4] },
] as const;
const DEMO_BOUNDS = DEMO_BOXES.map(box =>
  new Box3().setFromCenterAndSize(new Vector3(...box.center), new Vector3(...box.size)));

export function createMappingDemo(): Group {
  const root = new Group();
  root.name = 'Mapping simulation obstacles (not measured)';
  for (const box of DEMO_BOXES) {
    const solid = new BoxGeometry(...box.size);
    const edges = new EdgesGeometry(solid);
    solid.dispose();
    const line = new LineSegments(edges, new LineBasicMaterial({
      color: '#8194a8', transparent: true, opacity: 0.28, depthWrite: false,
    }));
    line.position.set(...box.center);
    root.add(line);
  }
  return root;
}

export function simulateMappingSample(pose: MappingPose, timestampMs: number): MappingSample {
  const origin = new Vector3(pose.x, pose.y, pose.z);
  if (DEMO_BOUNDS.some(box => box.containsPoint(origin))) throw new Error('模拟位置进入建图测试障碍物，已暂停采集');
  const rotation = attitudeQuaternion(0, 0, pose.yaw * 180 / Math.PI);
  const ranges = { front: null, back: null, left: null, right: null, up: null };
  const sample: MappingSample = {
    type: 'sample', timestampMs, poseTimestampMs: timestampMs, epoch: 0,
    x: -pose.x, y: pose.z, z: pose.y, roll: 0, pitch: 0, yaw: pose.yaw * 180 / Math.PI, ranges,
  };
  for (const direction of RANGE_DIRECTIONS) {
    const ray = new Ray(origin, RANGE_VECTORS[direction].clone().applyQuaternion(rotation));
    let nearest = 4;
    for (const box of DEMO_BOUNDS) {
      const hit = ray.intersectBox(box, new Vector3());
      if (hit) nearest = Math.min(nearest, hit.distanceTo(origin));
    }
    sample.ranges[direction] = nearest > 0 && nearest < 4 ? nearest : null;
  }
  return sample;
}

export class MappingCloud {
  readonly root = new Group();
  private readonly positions: Float32BufferAttribute;
  private readonly points: Points<BufferGeometry, PointsMaterial>;
  constructor(maximumVoxels: number) {
    this.root.name = 'Measured range voxel cloud';
    this.positions = new Float32BufferAttribute(new Float32Array(maximumVoxels * 3), 3);
    const geometry = new BufferGeometry().setAttribute('position', this.positions);
    geometry.setDrawRange(0, 0);
    this.points = new Points(geometry, new PointsMaterial({ color: '#45d6b0', size: 0.07, toneMapped: false }));
    this.points.frustumCulled = false;
    this.root.add(this.points);
  }
  update(map: RangeVoxelMap): void {
    let index = 0;
    for (const point of map.voxels.values()) this.positions.setXYZ(index++, point.x, point.y, point.z);
    this.positions.needsUpdate = true;
    this.points.geometry.setDrawRange(0, index);
    this.points.material.color.set(map.source === 'hardware' ? '#ffb454' : '#45d6b0');
    this.points.geometry.boundingBox = index === 0 ? new Box3() : new Box3().setFromPoints(
      Array.from(map.voxels.values(), point => new Vector3(point.x, point.y, point.z)));
  }
  dispose(): void {
    this.points.geometry.dispose();
    this.points.material.dispose();
    this.root.removeFromParent();
  }
}

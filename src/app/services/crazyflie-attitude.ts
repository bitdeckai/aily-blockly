import { MathUtils, Quaternion, Vector3 } from 'three';

export interface AttitudeSample {
  type: 'sample';
  timestampMs: number;
  roll: number;
  pitch: number;
  yaw: number;
}

export type AttitudeEvent = AttitudeSample | { type: 'error'; message: string }
  | { type: 'stopped' } | { type: 'state'; state: 'connecting' | 'flow' };
export interface AttitudeApi {
  startAttitude(options: { uri: string; addressHex: string }): Promise<{ success: boolean; message?: string }>;
  stopAttitude(): Promise<{ success: boolean; message?: string }>;
  onAttitude(callback: (event: AttitudeEvent) => void): () => void;
}

export function isAttitudeSample(value: unknown): value is AttitudeSample {
  if (typeof value !== 'object' || value === null) return false;
  return 'type' in value && value.type === 'sample'
    && 'roll' in value && typeof value.roll === 'number' && Number.isFinite(value.roll)
    && 'pitch' in value && typeof value.pitch === 'number' && Number.isFinite(value.pitch)
    && 'yaw' in value && typeof value.yaw === 'number' && Number.isFinite(value.yaw)
    && 'timestampMs' in value && typeof value.timestampMs === 'number' && Number.isFinite(value.timestampMs);
}

export function getAttitudeApi(): AttitudeApi | undefined {
  const bridge: unknown = window.electronAPI;
  if (typeof bridge !== 'object' || bridge === null || !('crazyflie' in bridge)) return undefined;
  const api: unknown = bridge.crazyflie;
  if (typeof api !== 'object' || api === null) return undefined;
  if ('startAttitude' in api && typeof api.startAttitude === 'function'
    && 'stopAttitude' in api && typeof api.stopAttitude === 'function'
    && 'onAttitude' in api && typeof api.onAttitude === 'function') {
    return api as AttitudeApi;
  }
  return undefined;
}

// Firmware logs legacy pitch with the opposite sign to its quaternion Euler
// pitch. Map body X/Y/Z to Three.js -X/+Z/+Y before applying the model offset.
export function attitudeQuaternion(roll: number, pitch: number, yaw: number, modelYaw = 0): Quaternion {
  const radians = MathUtils.degToRad;
  return new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), radians(yaw))
    .multiply(new Quaternion().setFromAxisAngle(new Vector3(0, 0, 1), -radians(pitch)))
    .multiply(new Quaternion().setFromAxisAngle(new Vector3(-1, 0, 0), radians(roll)))
    .multiply(new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), modelYaw));
}

export class AttitudeReception {
  sample: AttitudeSample | null = null;
  receivedAt: number | null = null;
  private times: number[] = [];

  receive(sample: unknown, now: number): boolean {
    if (!isAttitudeSample(sample)) return false;
    // Firmware timestamps wrap at 24 bits. Do not compare them with the PC clock.
    if (this.sample?.timestampMs === sample.timestampMs) return false;
    this.sample = sample;
    this.receivedAt = now;
    this.times.push(now);
    this.times = this.times.filter(time => now - time <= 2000);
    return true;
  }

  metrics(now: number): { ageMs: number | null; hz: number; stale: boolean } {
    const ageMs = this.receivedAt === null ? null : Math.max(0, now - this.receivedAt);
    const recent = this.times.filter(time => now - time <= 2000);
    const span = recent.length > 1 ? recent[recent.length - 1] - recent[0] : 0;
    return { ageMs, hz: span > 0 ? (recent.length - 1) * 1000 / span : 0, stale: ageMs === null || ageMs > 500 };
  }
}

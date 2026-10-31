import { parseAiDeckCameraCall } from './ai-deck-camera';

export const CAMERA_GESTURES = ['Open_Palm', 'Closed_Fist', 'Pointing_Up', 'Thumb_Up', 'Thumb_Down', 'Victory', 'ILoveYou',
  'OK', 'Swipe_Left', 'Swipe_Right', 'Swipe_Up', 'Swipe_Down'] as const;
export type CameraGesture = typeof CAMERA_GESTURES[number];
export type CameraSwipeGesture = Extract<CameraGesture, `Swipe_${string}`>;
export interface CameraHandPoint { x: number; y: number; z: number; }
export interface CameraGestureFrame {
  gestures: readonly (readonly { categoryName: string; score: number }[])[];
  landmarks?: readonly (readonly CameraHandPoint[])[];
  worldLandmarks?: readonly (readonly CameraHandPoint[])[];
}

export function isCameraSwipe(gesture: string): gesture is CameraSwipeGesture {
  return gesture === 'Swipe_Left' || gesture === 'Swipe_Right' || gesture === 'Swipe_Up' || gesture === 'Swipe_Down';
}

function completeHand(points: readonly CameraHandPoint[] | undefined): points is readonly CameraHandPoint[] {
  return points?.length === 21 && points.every(point =>
    Number.isFinite(point.x) && Number.isFinite(point.y) && Number.isFinite(point.z));
}

function distance(a: CameraHandPoint, b: CameraHandPoint): number {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
}

function jointAngle(a: CameraHandPoint, b: CameraHandPoint, c: CameraHandPoint): number {
  const ab = distance(a, b), bc = distance(b, c);
  if (ab < 1e-6 || bc < 1e-6) return 0;
  return Math.acos(Math.max(-1, Math.min(1,
    ((a.x - b.x) * (c.x - b.x) + (a.y - b.y) * (c.y - b.y) + (a.z - b.z) * (c.z - b.z)) / (ab * bc)))) * 180 / Math.PI;
}

export function recognizeCameraStaticGesture(frame: CameraGestureFrame): CameraGesture | null {
  if (frame.gestures.length !== 1 || frame.landmarks?.length !== 1) return null;
  const imageHand = frame.landmarks?.[0];
  if (!completeHand(imageHand) || imageHand.some(point => point.x < 0 || point.x > 1 || point.y < 0 || point.y > 1)) return null;
  const hand = completeHand(frame.worldLandmarks?.[0]) ? frame.worldLandmarks![0] : imageHand;
  if (completeHand(hand)) {
    const scale = distance(hand[5], hand[17]);
    if (scale > 1e-4) {
      const extended = (mcp: number) => jointAngle(hand[mcp], hand[mcp + 1], hand[mcp + 2]) >= 155
        && jointAngle(hand[mcp + 1], hand[mcp + 2], hand[mcp + 3]) >= 150
        && distance(hand[mcp], hand[mcp + 3]) >= distance(hand[mcp], hand[mcp + 1]) * 1.4;
      const index = extended(5), middle = extended(9), ring = extended(13), pinky = extended(17);
      if (!index && middle && ring && pinky && distance(hand[4], hand[8]) <= scale * 0.25
        && distance(hand[8], hand[5]) > scale * 0.25) return 'OK';
      // The existing identifier also accepts the one-finger pose when the hand is rotated.
      if (index && !middle && !ring && !pinky && distance(hand[4], hand[5]) < scale * 0.8) return 'Pointing_Up';
    }
  }
  const category = frame.gestures[0][0];
  return category && category.score >= 0.85 && isCameraGesture(category.categoryName)
    && !isCameraSwipe(category.categoryName) && category.categoryName !== 'OK' ? category.categoryName : null;
}

export class CameraPalmSwipe {
  private anchor: { x: number; y: number; scale: number; since: number } | null = null;
  private heldMs = 0;
  private movingAt: number | null = null;
  private direction: CameraSwipeGesture | null = null;
  private confirmations = 0;
  private lastFrame: number | null = null;
  private releasedAt: number | null = null;
  private latched = false;

  reset(): void {
    this.clearCandidate();
    this.lastFrame = null;
    this.releasedAt = null;
    this.latched = false;
  }

  private clearCandidate(): void {
    this.anchor = null;
    this.heldMs = 0;
    this.movingAt = null;
    this.direction = null;
    this.confirmations = 0;
  }

  update(gesture: CameraGesture | null, points: readonly CameraHandPoint[] | undefined, now: number,
    holdMs: (gesture: CameraSwipeGesture) => number): { gesture: CameraSwipeGesture; heldSeconds: number } | null {
    if (this.lastFrame !== null && now - this.lastFrame > 750) { this.clearCandidate(); this.releasedAt = null; }
    this.lastFrame = now;
    if (gesture !== 'Open_Palm' || !completeHand(points)
      || points.some(point => point.x < 0 || point.x > 1 || point.y < 0 || point.y > 1)) {
      this.clearCandidate();
      this.releasedAt ??= now;
      if (now - this.releasedAt >= 500) this.latched = false;
      return null;
    }
    this.releasedAt = null;
    if (this.latched) return null;
    const palm = [0, 5, 9, 13, 17].map(index => points[index]);
    const x = palm.reduce((sum, point) => sum + point.x, 0) / palm.length;
    const y = palm.reduce((sum, point) => sum + point.y, 0) / palm.length;
    const scale = Math.hypot(points[5].x - points[17].x, points[5].y - points[17].y);
    if (scale < 0.03) { this.clearCandidate(); return null; }
    if (!this.anchor) { this.anchor = { x, y, scale, since: now }; return null; }
    const anchor = this.anchor;
    if (Math.abs(scale / anchor.scale - 1) > 0.25) { this.clearCandidate(); return null; }
    const dx = x - anchor.x, dy = y - anchor.y;
    const travel = Math.hypot(dx, dy);
    if (this.movingAt === null && travel <= anchor.scale * 0.15) {
      this.heldMs = now - anchor.since;
      return null;
    }
    this.movingAt ??= now;
    if (now - this.movingAt > 1000) { this.clearCandidate(); return null; }
    const horizontal = Math.abs(dx) > Math.abs(dy);
    const major = horizontal ? Math.abs(dx) : Math.abs(dy);
    const minor = horizontal ? Math.abs(dy) : Math.abs(dx);
    if (major < Math.max(0.12, anchor.scale * 0.9) || minor > major * 0.35) {
      this.direction = null;
      this.confirmations = 0;
      return null;
    }
    const direction: CameraSwipeGesture = horizontal ? (dx < 0 ? 'Swipe_Left' : 'Swipe_Right') : (dy < 0 ? 'Swipe_Up' : 'Swipe_Down');
    if (this.heldMs < holdMs(direction)) { this.clearCandidate(); return null; }
    this.confirmations = this.direction === direction ? this.confirmations + 1 : 1;
    this.direction = direction;
    if (this.confirmations < 2) return null;
    this.latched = true;
    return { gesture: direction, heldSeconds: this.heldMs / 1000 };
  }
}
export interface CameraGestureBinding {
  gesture: CameraGesture;
  holdSeconds: number;
  code: string;
  blockIds: string[];
}
export interface CameraGestureState {
  phase: 'idle' | 'loading' | 'running' | 'error';
  gesture: CameraGesture | null;
  authorized: boolean;
  realMode: boolean;
  error: string;
}
export interface CameraFrameSource {
  prepareForRecognition(): Promise<HTMLImageElement>;
  frameIsFresh(): Promise<boolean>;
  recognitionAssetRoot(): string;
}
export type CameraGestureCommand = { type: 'start' | 'stop' } | { type: 'on'; binding: CameraGestureBinding };

export function isCameraGesture(value: unknown): value is CameraGesture {
  return typeof value === 'string' && CAMERA_GESTURES.some(gesture => gesture === value);
}

export function isCameraGestureProgram(code: string): boolean {
  return /^\s*cf_camera_gesture_/m.test(code);
}

export function parseCameraGestureCall(line: string): CameraGestureCommand | undefined {
  if (!line.startsWith('cf_camera_gesture_')) return undefined;
  const action = /^cf_camera_gesture_(start|stop)\(\s*\)\s*;?$/.exec(line)?.[1];
  if (action === 'start' || action === 'stop') return { type: action };
  const on = /^cf_camera_gesture_on\((.+)\)\s*;?$/.exec(line);
  if (!on) throw new Error('CAMERA_GESTURE.INVALID_PROGRAM');
  const binding: unknown = JSON.parse(on[1]);
  if (typeof binding !== 'object' || binding === null || !('gesture' in binding) || !isCameraGesture(binding.gesture)
    || !('holdSeconds' in binding) || typeof binding.holdSeconds !== 'number' || !Number.isFinite(binding.holdSeconds)
    || binding.holdSeconds < 0.5 || binding.holdSeconds > 5
    || !('code' in binding) || typeof binding.code !== 'string' || binding.code.length > 100000
    || isCameraGestureProgram(binding.code)
    || !('blockIds' in binding) || !Array.isArray(binding.blockIds)
    || !binding.blockIds.every(id => typeof id === 'string') || binding.blockIds.length > 10000) {
    throw new Error('CAMERA_GESTURE.INVALID_PROGRAM');
  }
  return { type: 'on', binding: {
    gesture: binding.gesture, holdSeconds: binding.holdSeconds, code: binding.code, blockIds: binding.blockIds,
  } };
}

export function validateCameraGestureProgram(code: string): void {
  if (!isCameraGestureProgram(code)) return;
  const gestures = new Set<CameraGesture>();
  for (const line of code.split(/\r?\n/).map(value => value.trim()).filter(value => value && !value.startsWith('#'))) {
    const command = parseCameraGestureCall(line);
    if (command?.type === 'on') {
      if (gestures.has(command.binding.gesture)) throw new Error('CAMERA_GESTURE.DUPLICATE_EVENT');
      gestures.add(command.binding.gesture);
    } else if (!command && !parseAiDeckCameraCall(line)) {
      const delay = /^cf_delay\(([0-9]*\.?[0-9]+)\)\s*;?$/.exec(line);
      const print = /^cf_print\(("(?:[^"\\]|\\.)*")\)\s*;?$/.exec(line);
      if (delay) {
        if (!Number.isFinite(Number(delay[1])) || Number(delay[1]) > 3600) throw new Error('CAMERA_GESTURE.INVALID_PROGRAM');
      } else if (print) {
        JSON.parse(print[1]);
      } else throw new Error('CAMERA_GESTURE.ACTIONS_IN_EVENT');
    }
  }
}

export class StableCameraGesture {
  private candidate: CameraGesture | null = null;
  private since = 0;
  private lastFrame = 0;
  private releasedAt: number | null = null;
  private latched: CameraGesture | null = null;

  reset(): void {
    this.candidate = null;
    this.lastFrame = 0;
    this.releasedAt = null;
    this.latched = null;
  }

  heldSeconds(now: number): number { return this.candidate ? (now - this.since) / 1000 : 0; }

  update(gesture: CameraGesture | null, now: number, holdMs: number): CameraGesture | null {
    if (now - this.lastFrame > 750) { this.candidate = null; this.releasedAt = null; }
    this.lastFrame = now;
    if (!gesture) {
      this.candidate = null;
      this.releasedAt ??= now;
      if (now - this.releasedAt >= 500) this.latched = null;
      return null;
    }
    this.releasedAt = null;
    if (this.candidate !== gesture) {
      this.candidate = gesture;
      this.since = now;
    }
    if (this.latched === gesture || now - this.since < holdMs) return null;
    this.latched = gesture;
    return gesture;
  }
}

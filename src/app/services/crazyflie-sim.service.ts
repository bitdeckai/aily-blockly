import { Injectable } from '@angular/core';
import { BehaviorSubject } from 'rxjs';
import { AiDeckCameraCommand, isAiDeckCameraOnlyFlow, parseAiDeckCameraCall, validateAiDeckCameraSequence } from './ai-deck-camera';
import { AiDeckCameraService } from './ai-deck-camera.service';
import { CrazyflieConnectionService } from './crazyflie-connection.service';
import { getClassroomDeskLayout } from './crazyflie-classroom';
import { AttitudeReception, AttitudeSample, FlightPoseSample, isFlightPoseSample, relativeFlightPose } from './crazyflie-attitude';
import { MotionCommand, motionDurationSeconds, parseMotionCall, validateMotionSequence } from '../editors/blockly-editor/components/blockly/generators/crazyflie/motion-blocks';
import { validateRadioScanSequence } from '../editors/blockly-editor/components/blockly/generators/crazyflie/radio-blocks';
import { CrazyflieRoomPreset, ExplorationProgress, ExplorationTracker, getExplorationScene, HOME_ROOM_SIZE, COORDINATE_ROOM_SIZE } from './crazyflie-exploration';
export type { CrazyflieRoomPreset } from './crazyflie-exploration';

export interface CrazyfliePose {
  x: number;
  y: number;
  z: number;
  yaw: number;
}

type CrazyflieSimCommand = {
  type: 'motion' | 'takeoff' | 'land' | 'spin_motors' | 'delay' | 'move' | 'print' | 'set_link' | 'test_link' | 'scan_links' | 'crazyflie_link' | 'test_crazyflie_link' | 'detect_flow_v2' | 'detect_multiranger' | 'mr_log_distance' | 'mr_log_all_distances' | 'detect_led_ring' | 'led_ring_set_color' | 'led_ring_set_effect' | 'led_ring_off' | 'detect_buzzer' | 'buzzer_beep';
  value?: any;
} | { type: 'ai_deck'; value: AiDeckCameraCommand };

export interface CrazyflieStepEvent {
  current: number;
  total: number;
  label: string;
}

@Injectable({
  providedIn: 'root',
})
export class CrazyflieSimService {
  private readonly originPose: CrazyfliePose = { x: 0, y: 0.06, z: 0, yaw: 0 };
  private readonly baseMoveSpeedMps = 0.2;

  constructor(
    private readonly connectionService: CrazyflieConnectionService,
    private readonly aiDeckCamera: AiDeckCameraService,
  ) {}

  panelVisible$ = new BehaviorSubject<boolean>(false);
  running$ = new BehaviorSubject<boolean>(false);
  pose$ = new BehaviorSubject<CrazyfliePose>(getClassroomDeskLayout().helipadPose);
  step$ = new BehaviorSubject<CrazyflieStepEvent | null>(null);
  logs$ = new BehaviorSubject<string[]>([]);
  paused$ = new BehaviorSubject<boolean>(false);
  speed$ = new BehaviorSubject<number>(1);
  readonly followingReal$ = new BehaviorSubject<boolean>(false);
  readonly poseSource$ = new BehaviorSubject<'simulation' | 'real'>('simulation');
  readonly realAttitude$ = new BehaviorSubject<AttitudeSample | null>(null);
  readonly realStatus$ = new BehaviorSubject<string>('未开启真机同步');
  realReception = new AttitudeReception();
  private realReference: FlightPoseSample | null = null;
  private realOrigin: CrazyfliePose | null = null;
  private realFlightOrigin: CrazyfliePose | null = null;
  private takeoffReferenceOrigin: CrazyfliePose | null = null;
  private hasRealTakeoff = false;

  roomPreset$ = new BehaviorSubject<CrazyflieRoomPreset>('classroom');
  roomSize$ = new BehaviorSubject<{ width: number; depth: number; height: number }>({
    width: 8.2,
    depth: 6.2,
    height: 3,
  });
  floorPlanUrl$ = new BehaviorSubject<string | null>(null);
  sceneModelUrl$ = new BehaviorSubject<string | null>(null);
  readonly explorationProgress$ = new BehaviorSubject<ExplorationProgress>({ visited: [], dwelling: null, dwellPercent: 0 });
  readonly mapTargetId$ = new BehaviorSubject<number | null>(null);
  private explorationTracker = new ExplorationTracker([]);
  private explorationClockMs = 0;

  private cancelRequested = false;
  private stepOnceTokens = 0;
  private floorPlanObjectUrl: string | null = null;
  private sceneModelObjectUrl: string | null = null;

  setPanelVisible(visible: boolean): void {
    this.panelVisible$.next(visible);
  }

  togglePanel(): void {
    this.panelVisible$.next(!this.panelVisible$.value);
  }

  cancelRun(): void {
    this.cancelRequested = true;
    this.advanceExploration(0);
  }

  setPaused(paused: boolean): void {
    this.paused$.next(paused);
    if (paused) this.advanceExploration(0);
  }

  togglePause(): void {
    this.setPaused(!this.paused$.value);
  }

  requestStepOnce(): void {
    this.stepOnceTokens += 1;
    this.setPaused(true);
  }

  setSpeed(speed: number): void {
    const next = Math.max(0.2, Math.min(3, Number(speed) || 1));
    this.speed$.next(next);
  }

  setRoomPreset(preset: CrazyflieRoomPreset): void {
    if (this.running$.value) throw new Error('运行期间不能切换场景');
    this.mapTargetId$.next(null);
    this.roomPreset$.next(preset);
    if (preset === 'classroom') {
      this.roomSize$.next({ width: 8.2, depth: 6.2, height: 3 });
    } else if (preset === 'home') {
      this.roomSize$.next({ ...HOME_ROOM_SIZE });
    } else if (preset === 'coordinates') {
      this.roomSize$.next({ ...COORDINATE_ROOM_SIZE });
    } else {
      const exploration = getExplorationScene(preset);
      if (exploration) this.roomSize$.next({ ...exploration.size });
    }

    if (!this.running$.value) {
      this.resetPose();
    }
  }

  async importFloorPlan(file: File): Promise<void> {
    if (this.floorPlanObjectUrl) {
      URL.revokeObjectURL(this.floorPlanObjectUrl);
      this.floorPlanObjectUrl = null;
    }

    this.floorPlanObjectUrl = URL.createObjectURL(file);
    this.floorPlanUrl$.next(this.floorPlanObjectUrl);
    this.setRoomPreset('custom');
  }

  async importSceneModel(file: File): Promise<void> {
    if (this.sceneModelObjectUrl) {
      URL.revokeObjectURL(this.sceneModelObjectUrl);
      this.sceneModelObjectUrl = null;
    }

    this.sceneModelObjectUrl = URL.createObjectURL(file);
    this.sceneModelUrl$.next(this.sceneModelObjectUrl);
    this.setRoomPreset('custom');
  }

  clearFloorPlan(): void {
    if (this.floorPlanObjectUrl) {
      URL.revokeObjectURL(this.floorPlanObjectUrl);
      this.floorPlanObjectUrl = null;
    }
    this.floorPlanUrl$.next(null);
  }

  clearSceneModel(): void {
    if (this.sceneModelObjectUrl) {
      URL.revokeObjectURL(this.sceneModelObjectUrl);
      this.sceneModelObjectUrl = null;
    }
    this.sceneModelUrl$.next(null);
  }

  resetPose(): void {
    if (this.followingReal$.value) throw new Error('真机同步期间不能复位；复位不会控制真机');
    if (this.running$.value) throw new Error('运行期间不能复位模型');
    this.poseSource$.next('simulation');
    this.realAttitude$.next(null);
    this.realFlightOrigin = null;
    this.pose$.next(this.getResetPoseForPreset(this.roomPreset$.value));
    this.resetExploration();
  }

  resetExploration(): void {
    if (this.running$.value) throw new Error('运行期间不能重置打卡进度');
    this.explorationTracker = new ExplorationTracker(getExplorationScene(this.roomPreset$.value)?.points ?? []);
    this.explorationClockMs = 0;
    this.explorationProgress$.next({ visited: [], dwelling: null, dwellPercent: 0 });
  }

  setMapTarget(id: number | null): void {
    const scene = getExplorationScene(this.roomPreset$.value);
    if (!scene?.geography) throw new Error('当前场景不支持地图区域目标');
    if (id !== null && !scene.points.some(point => point.id === id)) throw new Error('不支持的地图区域目标');
    this.mapTargetId$.next(id);
    this.advanceExploration(0);
  }

  private advanceExploration(durationMs: number): void {
    this.explorationClockMs += durationMs;
    const progress = this.explorationTracker.update(this.pose$.value, this.explorationClockMs,
      this.running$.value && !this.paused$.value && !this.cancelRequested && this.poseSource$.value === 'simulation',
      getExplorationScene(this.roomPreset$.value)?.geography ? this.mapTargetId$.value : undefined);
    const previous = this.explorationProgress$.value;
    if (progress.dwelling !== previous.dwelling || progress.dwellPercent !== previous.dwellPercent
      || progress.visited.length !== previous.visited.length) this.explorationProgress$.next(progress);
  }

  beginRealFollow(): void {
    if (this.running$.value) throw new Error('已有运行中的流程，请先结束当前流程');
    this.resetPose();
    this.realOrigin = { ...this.pose$.value };
    this.realFlightOrigin = { ...this.realOrigin };
    this.takeoffReferenceOrigin = null;
    this.hasRealTakeoff = false;
    this.resetRealReference();
    this.logs$.next([]);
    this.step$.next(null);
    this.paused$.next(false);
    this.speed$.next(1);
    this.poseSource$.next('real');
    this.followingReal$.next(true);
    this.running$.next(true);
  }

  prepareRealStep(label: string): void {
    if (!this.followingReal$.value) return;
    this.takeoffReferenceOrigin = null;
    if (label === 'takeoff' || label.startsWith('motion:takeoff:')) {
      // Only the commanded takeoff calibration discards drift accumulated before the first takeoff.
      const origin = this.hasRealTakeoff ? this.pose$.value : this.realFlightOrigin;
      if (!origin) throw new Error('真机同步起点尚未初始化，不能校准起飞参考点');
      this.takeoffReferenceOrigin = { ...origin };
      this.hasRealTakeoff = true;
    }
  }

  get relativeAltitudeCm(): number {
    const origin = this.poseSource$.value === 'real' && this.realFlightOrigin
      ? this.realFlightOrigin : this.getResetPoseForPreset(this.roomPreset$.value);
    return Math.round((this.pose$.value.y - origin.y) * 100);
  }

  resetRealReference(): void {
    if (this.followingReal$.value) this.realOrigin = { ...(this.takeoffReferenceOrigin ?? this.pose$.value) };
    this.takeoffReferenceOrigin = null;
    this.realReference = null;
    this.realReception = new AttitudeReception();
    this.realStatus$.next('等待机载估计位置和姿态，首帧对齐参考点…');
  }

  receiveRealPose(value: unknown, now: number): void {
    if (!this.followingReal$.value || !this.realOrigin) return;
    if (!isFlightPoseSample(value)) throw new Error('真机同步缺少有效的 XYZ 位置或姿态');
    if (!this.realReception.receive(value, now)) return;
    this.realReference ??= value;
    const pose = relativeFlightPose(value, this.realReference, this.realOrigin);
    this.realAttitude$.next({ ...value, yaw: pose.yaw * 180 / Math.PI });
    this.pose$.next(pose);
    this.realStatus$.next('真机估计位置与姿态（相对起点）');
  }

  endRealFollow(message: string): void {
    this.takeoffReferenceOrigin = null;
    this.realStatus$.next(message);
    this.followingReal$.next(false);
    this.running$.next(false);
  }

  async runCode(code: string): Promise<{ success: boolean; message: string; executed: string[] }> {
    if (this.running$.value) {
      return { success: false, message: '模拟正在运行中', executed: [] };
    }

    const commands = this.parseCommands(code);
    validateRadioScanSequence(commands);
    validateMotionSequence(commands);
    validateAiDeckCameraSequence(code);
    const cameraOnly = isAiDeckCameraOnlyFlow(code);
    if (commands.length === 0) {
      return { success: false, message: '未检测到可模拟的 Crazyflie 指令', executed: [] };
    }

    const executable = commands;
    const total = executable.length;
    const executed: string[] = [];

    this.cancelRequested = false;
    this.stepOnceTokens = 0;
    this.step$.next(null);
    this.logs$.next([]);
    this.paused$.next(false);
    if (!cameraOnly) this.resetPose();
    this.running$.next(true);

    const pose: CrazyfliePose = this.getResetPoseForPreset(this.roomPreset$.value);
    let current = 0;

    try {
      for (const command of commands) {
        if (this.cancelRequested) {
          break;
        }

        const canContinue = await this.waitForRunPermission();
        if (!canContinue) {
          break;
        }

        current += 1;
        const label = this.commandLabel(command);
        this.step$.next({ current, total, label });

        switch (command.type) {
          case 'ai_deck':
            this.aiDeckCamera.execute(command.value);
            this.appendLog(`AI Deck: ${command.value.type}`);
            executed.push(`ai_deck:${command.value.type}`);
            break;
          case 'motion': {
            const motion: MotionCommand = command.value;
            this.appendLog(`sim: ${motion.kind} ${motion.values.join(', ')}`);
            executed.push(`motion:${motion.kind}:${motion.values.join(':')}`);
            await this.animateMotion(pose, motion);
            break;
          }
          case 'set_link':
            this.appendLog(`sim: set_link uri=${String(command.value?.uri || 'radio://0/80/2M')} address=${String(command.value?.address || 'E7E7E7E7E7')}`);
            executed.push(`set_link:${String(command.value?.uri || 'radio://0/80/2M')}:${String(command.value?.address || 'E7E7E7E7E7')}`);
            await this.waitWithControl(120, true);
            break;
          case 'test_link':
            this.appendLog('sim: test_link');
            executed.push('test_link');
            await this.waitWithControl(120, true);
            break;
          case 'scan_links':
            this.appendLog('sim: scan_links (simulation only; no radio scan)');
            executed.push('scan_links');
            await this.waitWithControl(120, true);
            break;
          case 'crazyflie_link':
            this.appendLog('sim: crazyflie_link');
            executed.push('crazyflie_link');
            await this.waitWithControl(150, true);
            break;
          case 'test_crazyflie_link':
            this.appendLog('sim: self-test (estimated 5 seconds; simulation only, no firmware result)');
            executed.push('test_crazyflie_link');
            await this.waitWithControl(5000, true);
            break;
          case 'detect_flow_v2':
            this.connectionService.setDeckDetected('flow-v2', true);
            this.appendLog('sim: detect_flow_v2 => true');
            executed.push('detect_flow_v2:1');
            await this.waitWithControl(180, true);
            break;
          case 'detect_multiranger':
            this.connectionService.setDeckDetected('multiranger', true);
            this.appendLog('sim: detect_multiranger => true');
            executed.push('detect_multiranger:1');
            await this.waitWithControl(180, true);
            break;
          case 'mr_log_distance': {
            const dir = String(command.value?.dir || 'front');
            const distances = this.getSimRangeDistances(pose);
            const distance = this.formatDistanceMeters(distances[dir] ?? null);
            this.appendLog(`sim: mr_${dir}=${distance}`);
            executed.push(`mr_log_distance:${dir}:${distance}`);
            await this.waitWithControl(140, true);
            break;
          }
          case 'mr_log_all_distances': {
            const distances = this.getSimRangeDistances(pose);
            const line = ['front', 'back', 'left', 'right', 'up']
              .map((key) => `${key}=${this.formatDistanceMeters(distances[key] ?? null)}`)
              .join(',');
            this.appendLog(`sim: ${line}`);
            executed.push(`mr_log_all_distances:${line}`);
            await this.waitWithControl(160, true);
            break;
          }
          case 'detect_led_ring':
            this.connectionService.setDeckDetected('led-ring', true);
            this.appendLog('sim: detect_led_ring => true');
            executed.push('detect_led_ring:1');
            await this.waitWithControl(120, true);
            break;
          case 'led_ring_set_color': {
            const r = Math.max(0, Math.min(255, Number(command.value?.r ?? 255)));
            const g = Math.max(0, Math.min(255, Number(command.value?.g ?? 0)));
            const b = Math.max(0, Math.min(255, Number(command.value?.b ?? 0)));
            this.appendLog(`sim: led_ring_set_color ${r},${g},${b}`);
            executed.push(`led_ring_set_color:${r}:${g}:${b}`);
            await this.waitWithControl(120, true);
            break;
          }
          case 'led_ring_set_effect': {
            const effect = Math.max(0, Number(command.value?.effect ?? 0));
            this.appendLog(`sim: led_ring_set_effect ${effect}`);
            executed.push(`led_ring_set_effect:${effect}`);
            await this.waitWithControl(120, true);
            break;
          }
          case 'led_ring_off':
            this.appendLog('sim: led_ring_off');
            executed.push('led_ring_off');
            await this.waitWithControl(120, true);
            break;
          case 'detect_buzzer':
            this.connectionService.setDeckDetected('buzzer', true);
            this.appendLog('sim: detect_buzzer => true');
            executed.push('detect_buzzer:1');
            await this.waitWithControl(120, true);
            break;
          case 'buzzer_beep': {
            const duration = Math.max(20, Number(command.value?.duration ?? 120));
            const times = Math.max(1, Number(command.value?.times ?? 1));
            this.appendLog(`sim: buzzer_beep duration=${duration}ms times=${times}`);
            executed.push(`buzzer_beep:${duration}:${times}:1`);
            await this.waitWithControl(120, true);
            break;
          }
          case 'takeoff':
            this.appendLog('sim: takeoff');
            executed.push('takeoff');
            await this.waitWithControl(2100, true);
            await this.animateMotion(pose, { kind: 'takeoff', values: [0.3, this.baseMoveSpeedMps] });
            await this.waitWithControl(500, true);
            break;
          case 'land':
            this.appendLog('sim: land');
            executed.push('land');
            await this.animateMotion(pose, { kind: 'land', values: [this.baseMoveSpeedMps] });
            break;
          case 'spin_motors': {
            const start = Math.max(1000, Math.min(60000, Number(command.value?.start ?? 20000)));
            const end = Math.max(1000, Math.min(60000, Number(command.value?.end ?? 25000)));
            const step = Math.max(50, Math.min(5000, Number(command.value?.step ?? 500)));
            const intervalMs = Math.max(20, Math.min(500, Number(command.value?.intervalMs ?? 100)));
            const settleSecs = Math.max(0.2, Math.min(5, Number(command.value?.settleSecs ?? 0.8)));
            this.appendLog(`sim: motor_ramp_test start=${start} end=${end} step=${step} interval=${intervalMs}ms settle=${settleSecs}s`);
            executed.push(`motor_ramp_test:${start}:${end}:${step}:${intervalMs}:${settleSecs.toFixed(2)}:1`);
            const span = Math.abs(end - start);
            const rampCount = Math.floor(span / step) + 1;
            const totalMs = Math.max(200, rampCount * intervalMs * 2 + settleSecs * 1000);
            await this.waitWithControl(totalMs, false);
            break;
          }
          case 'delay': {
            const sec = Math.max(0, Number(command.value || 0));
            this.appendLog(`sim: delay ${sec}s`);
            executed.push(`delay:${sec}`);
            // Delay must match real timing in simulation.
            await this.waitWithControl(sec * 1000, false);
            break;
          }
          case 'print': {
            const msg = String(command.value || '');
            this.appendLog(`print: ${msg}`);
            executed.push(`print:${msg}`);
            await this.waitWithControl(120, true);
            break;
          }
          case 'move': {
            const direction = String(command.value?.dir || 'forward');
            const distance = Math.max(0.01, Number(command.value?.distance || 0.2));
            this.appendLog(`sim: move ${direction} ${distance}m`);
            executed.push(`move:${direction}:${distance}`);
            await this.movePoseOverTime(pose, direction, distance);
            await this.waitWithControl(600, true);
            break;
          }
          default:
            break;
        }
      }

      const cancelled = this.cancelRequested;
      this.cancelRequested = false;
      this.stepOnceTokens = 0;
      this.running$.next(false);
      this.advanceExploration(0);
      this.step$.next(null);
      this.paused$.next(false);

      if (cancelled) {
        this.appendLog('sim: cancelled');
        return { success: false, message: cameraOnly ? 'AI Deck 摄像头流程已取消' : '模拟已取消', executed };
      }

      this.appendLog('sim: finished');
      return { success: true, message: cameraOnly ? 'AI Deck 摄像头流程执行完成' : '模拟执行完成', executed };
    } catch (error: any) {
      this.running$.next(false);
      this.advanceExploration(0);
      this.step$.next(null);
      this.paused$.next(false);
      this.appendLog(`sim error: ${error?.message || String(error)}`);
      return { success: false, message: error?.message || '模拟执行失败', executed };
    }
  }

  private async waitForRunPermission(): Promise<boolean> {
    while (this.running$.value) {
      if (this.cancelRequested) {
        return false;
      }

      if (!this.paused$.value) {
        return true;
      }

      if (this.stepOnceTokens > 0) {
        this.stepOnceTokens -= 1;
        return true;
      }

      await this.sleep(40);
    }

    return false;
  }

  private async waitWithControl(durationMs: number, speedAware: boolean): Promise<void> {
    const speed = this.speed$.value;
    const effectiveMs = speedAware ? Math.max(1, durationMs / Math.max(0.2, speed)) : Math.max(1, durationMs);
    let remaining = effectiveMs;

    while (remaining > 0) {
      if (this.cancelRequested) {
        return;
      }

      if (this.paused$.value) {
        await this.waitForRunPermission();
        continue;
      }

      const slice = Math.min(remaining, 80);
      await this.sleep(slice);
      remaining -= slice;
    }
  }

  private appendLog(line: string): void {
    const next = [...this.logs$.value, line];
    this.logs$.next(next.slice(-300));
  }

  private getResetPoseForPreset(preset: CrazyflieRoomPreset): CrazyfliePose {
    if (preset === 'coordinates') return { x: 0, y: 0, z: 0, yaw: 0 };
    if (preset === 'classroom') {
      return getClassroomDeskLayout().helipadPose;
    }
    return { ...this.originPose };
  }

  private getLandingReferenceY(): number {
    if (this.roomPreset$.value === 'coordinates') return 0;
    return Math.max(0.06, this.getResetPoseForPreset(this.roomPreset$.value).y);
  }

  private applyMove(pose: CrazyfliePose, direction: string, distance: number): void {
    const vectors: Record<string, number[]> = {
      forward: [distance, 0, 0], back: [-distance, 0, 0],
      left: [0, distance, 0], right: [0, -distance, 0],
      up: [0, 0, distance], down: [0, 0, -distance],
    };
    const [x, y, z] = vectors[direction];
    this.translateBody(pose, x, y, z);
    pose.y = Math.max(this.getLandingReferenceY(), pose.y);
  }

  private translateBody(pose: CrazyfliePose, x: number, y: number, z: number): void {
    pose.x += -Math.cos(pose.yaw) * x + Math.sin(pose.yaw) * y;
    pose.z += Math.sin(pose.yaw) * x + Math.cos(pose.yaw) * y;
    pose.y += z;
  }

  private async animateMotion(pose: CrazyfliePose, command: MotionCommand): Promise<void> {
    const start = { ...pose };
    const values = command.values;
    const duration = motionDurationSeconds(command, start.y - this.getLandingReferenceY());
    const radians = Math.PI / 180;
    let elapsed = 0;
    do {
      if (this.cancelRequested || !(await this.waitForRunPermission())) return;
      const slice = Math.min(40, Math.max(0, duration * 1000 - elapsed));
      if (slice) await this.sleep(slice / this.speed$.value);
      if (this.cancelRequested) return;
      elapsed += slice;
      const t = duration > 0 ? Math.min(1, elapsed / (duration * 1000)) : 1;
      Object.assign(pose, start);
      switch (command.kind) {
        case 'takeoff': pose.y = this.getLandingReferenceY() + values[0] * t; break;
        case 'land': pose.y = start.y + (this.getLandingReferenceY() - start.y) * t; break;
        case 'move': this.translateBody(pose, values[0] * t, values[1] * t, values[2] * t); break;
        case 'turn': pose.yaw = start.yaw + values[0] * radians * t; break;
        case 'circle': {
          const angle = values[1] * radians * t;
          const radius = values[0] * Math.sign(values[1]);
          this.translateBody(pose, radius * Math.sin(angle), radius * (1 - Math.cos(angle)), 0);
          pose.yaw = start.yaw + angle;
          break;
        }
      }
      this.pose$.next({ ...pose });
    } while (elapsed < duration * 1000);
  }

  private async movePoseOverTime(pose: CrazyfliePose, direction: string, distance: number): Promise<void> {
    const startPose: CrazyfliePose = { ...pose };
    const targetPose: CrazyfliePose = { ...pose };
    this.applyMove(targetPose, direction, distance);

    const speedScale = Math.max(0.2, Number(this.speed$.value || 1));
    const velocity = this.baseMoveSpeedMps * speedScale;
    const durationMs = Math.max(120, (Math.max(0.01, distance) / Math.max(0.05, velocity)) * 1000);

    let elapsedMs = 0;
    while (elapsedMs < durationMs) {
      if (this.cancelRequested) {
        return;
      }

      const canContinue = await this.waitForRunPermission();
      if (!canContinue) {
        return;
      }

      const sliceMs = Math.min(40, durationMs - elapsedMs);
      await this.sleep(sliceMs);
      elapsedMs += sliceMs;

      const t = Math.max(0, Math.min(1, elapsedMs / durationMs));
      pose.x = startPose.x + (targetPose.x - startPose.x) * t;
      pose.y = startPose.y + (targetPose.y - startPose.y) * t;
      pose.z = startPose.z + (targetPose.z - startPose.z) * t;
      this.pose$.next({ ...pose });
    }

    pose.x = targetPose.x;
    pose.y = targetPose.y;
    pose.z = targetPose.z;
    this.pose$.next({ ...pose });
  }

  private commandLabel(command: CrazyflieSimCommand): string {
    switch (command.type) {
      case 'ai_deck':
        return `ai_deck:${command.value.type}`;
      case 'motion':
        return `motion:${command.value.kind}:${command.value.values.join(':')}`;
      case 'takeoff':
        return 'takeoff';
      case 'land':
        return 'land';
      case 'spin_motors':
        return `motor_ramp_test:${Number(command.value?.start ?? 20000)}:${Number(command.value?.end ?? 25000)}:${Number(command.value?.step ?? 500)}:${Number(command.value?.intervalMs ?? 100)}:${Number(command.value?.settleSecs ?? 0.8)}`;
      case 'delay':
        return `delay:${Number(command.value || 0)}`;
      case 'print':
        return `print:${String(command.value || '')}`;
      case 'detect_flow_v2':
        return 'detect_flow_v2';
      case 'detect_multiranger':
        return 'detect_multiranger';
      case 'mr_log_distance':
        return `mr_log_distance:${String(command.value?.dir || 'front')}`;
      case 'mr_log_all_distances':
        return 'mr_log_all_distances';
      case 'detect_led_ring':
        return 'detect_led_ring';
      case 'led_ring_set_color':
        return `led_ring_set_color:${Number(command.value?.r ?? 255)}:${Number(command.value?.g ?? 0)}:${Number(command.value?.b ?? 0)}`;
      case 'led_ring_set_effect':
        return `led_ring_set_effect:${Number(command.value?.effect ?? 0)}`;
      case 'led_ring_off':
        return 'led_ring_off';
      case 'detect_buzzer':
        return 'detect_buzzer';
      case 'buzzer_beep':
        return `buzzer_beep:${Number(command.value?.duration ?? 120)}:${Number(command.value?.times ?? 1)}`;
      case 'set_link':
        return `set_link:${String(command.value?.uri || '')}:${String(command.value?.address || '')}`;
      case 'test_link':
        return 'test_link';
      case 'crazyflie_link':
        return 'crazyflie_link';
      case 'test_crazyflie_link':
        return 'test_crazyflie_link:basic';
      case 'move':
        return `move:${String(command.value?.dir || '')}:${Number(command.value?.distance || 0)}`;
      default:
        return command.type;
    }
  }

  private parseCommands(code: string): CrazyflieSimCommand[] {
    const commands: CrazyflieSimCommand[] = [];
    for (const raw of String(code || '').split(/\r?\n/)) {
      const line = raw.trim();
      if (!line || line.startsWith('//') || line.startsWith('#')) {
        continue;
      }
      const motion = parseMotionCall(line);
      const camera = parseAiDeckCameraCall(line);
      if (camera) {
        commands.push({ type: 'ai_deck', value: camera });
        continue;
      }
      if (motion) {
        commands.push({ type: 'motion', value: motion });
        continue;
      }

      const setLinkMatch = /^cf_set_link\s*\(\s*['\"](.*?)['\"]\s*,\s*['\"](.*?)['\"]\s*\)\s*;?$/.exec(line);
      if (setLinkMatch) {
        commands.push({ type: 'set_link', value: { uri: setLinkMatch[1], address: setLinkMatch[2] } });
        continue;
      }

      if (/^cf_test_link\s*\(/.test(line)) {
        commands.push({ type: 'test_link' });
        continue;
      }

      if (/^cf_scan_links\s*\(\s*\)\s*;?$/.test(line)) {
        commands.push({ type: 'scan_links' });
        continue;
      }

      if (/^cf_crazyflie_link\s*\(\s*\)\s*;?$/.test(line)) {
        commands.push({ type: 'crazyflie_link' });
        continue;
      }

      if (/^cf_test_crazyflie_link\s*\(\s*\)\s*;?$/.test(line)) {
        commands.push({ type: 'test_crazyflie_link' });
        continue;
      }
      if (/^cf_detect_flow_v2\s*\(\s*\)\s*;?$/.test(line)) {
        commands.push({ type: 'detect_flow_v2' });
        continue;
      }
      if (/^cf_detect_multiranger\s*\(\s*\)\s*;?$/.test(line)) {
        commands.push({ type: 'detect_multiranger' });
        continue;
      }

      const mrLogDistanceMatch = /^cf_mr_log_distance\s*\(\s*['\"](front|back|left|right|up)['\"]\s*\)\s*;?$/.exec(line);
      if (mrLogDistanceMatch) {
        commands.push({ type: 'mr_log_distance', value: { dir: mrLogDistanceMatch[1] } });
        continue;
      }

      if (/^cf_mr_log_all_distances\s*\(\s*\)\s*;?$/.test(line)) {
        commands.push({ type: 'mr_log_all_distances' });
        continue;
      }
      if (/^cf_detect_led_ring\s*\(\s*\)\s*;?$/.test(line)) {
        commands.push({ type: 'detect_led_ring' });
        continue;
      }

      const ledSetColorMatch = /^cf_led_ring_set_color\s*\(\s*([0-9]+)\s*,\s*([0-9]+)\s*,\s*([0-9]+)\s*\)\s*;?$/.exec(line);
      if (ledSetColorMatch) {
        commands.push({
          type: 'led_ring_set_color',
          value: { r: Number(ledSetColorMatch[1]), g: Number(ledSetColorMatch[2]), b: Number(ledSetColorMatch[3]) },
        });
        continue;
      }

      const ledEffectMatch = /^cf_led_ring_set_effect\s*\(\s*([0-9]+)\s*\)\s*;?$/.exec(line);
      if (ledEffectMatch) {
        commands.push({ type: 'led_ring_set_effect', value: { effect: Number(ledEffectMatch[1]) } });
        continue;
      }

      if (/^cf_led_ring_off\s*\(\s*\)\s*;?$/.test(line)) {
        commands.push({ type: 'led_ring_off' });
        continue;
      }

      if (/^cf_detect_buzzer\s*\(\s*\)\s*;?$/.test(line)) {
        commands.push({ type: 'detect_buzzer' });
        continue;
      }

      const buzzerMatch = /^cf_buzzer_beep\s*\(\s*([0-9]+)\s*,\s*([0-9]+)\s*\)\s*;?$/.exec(line);
      if (buzzerMatch) {
        commands.push({ type: 'buzzer_beep', value: { duration: Number(buzzerMatch[1]), times: Number(buzzerMatch[2]) } });
        continue;
      }
      if (/^cf_takeoff\s*\(\s*\)\s*;?$/.test(line)) {
        commands.push({ type: 'takeoff' });
        continue;
      }
      if (/^cf_land\s*\(\s*\)\s*;?$/.test(line)) {
        commands.push({ type: 'land' });
        continue;
      }

      const motorRampMatch = /^cf_motor_ramp_test\s*\(\s*([0-9]+)\s*,\s*([0-9]+)\s*,\s*([0-9]+)\s*,\s*([0-9]+)\s*,\s*([0-9]*\.?[0-9]+)\s*\)\s*;?$/.exec(line);
      if (motorRampMatch) {
        commands.push({
          type: 'spin_motors',
          value: {
            start: Number(motorRampMatch[1]),
            end: Number(motorRampMatch[2]),
            step: Number(motorRampMatch[3]),
            intervalMs: Number(motorRampMatch[4]),
            settleSecs: Number(motorRampMatch[5]),
          },
        });
        continue;
      }

      const delayMatch = /^cf_delay\s*\(\s*([0-9]*\.?[0-9]+)\s*\)\s*;?$/.exec(line);
      if (delayMatch) {
        commands.push({ type: 'delay', value: Number(delayMatch[1]) });
        continue;
      }

      const printMatch = /^cf_print\s*\(\s*(.*?)\s*\)\s*;?$/.exec(line);
      if (printMatch) {
        commands.push({ type: 'print', value: this.normalizePrintValue(printMatch[1]) });
        continue;
      }

      const moveMatch = /^cf_move\s*\(\s*['\"](forward|back|left|right|up|down)['\"]\s*(?:,\s*([0-9]*\.?[0-9]+)\s*)?\)\s*;?$/.exec(line);
      if (moveMatch) {
        commands.push({
          type: 'move',
          value: {
            dir: moveMatch[1],
            distance: moveMatch[2] != null ? Number(moveMatch[2]) : this.defaultDistance(moveMatch[1]),
          },
        });
        continue;
      }
    }
    return commands;
  }

  private normalizePrintValue(value: string): string {
    const text = String(value || '').trim();
    if (text.startsWith('"') && text.endsWith('"')) {
      const parsed: unknown = JSON.parse(text);
      if (typeof parsed !== 'string') {
        throw new Error('Crazyflie：打印内容必须是文字');
      }
      return parsed;
    }
    if (text.length >= 2 && ((text.startsWith("'") && text.endsWith("'")) || (text.startsWith('"') && text.endsWith('"')))) {
      return text.slice(1, -1).replace(/\\n/g, '\n').replace(/\\r/g, '\r').replace(/\\'/g, "'").replace(/\\\"/g, '"').replace(/\\\\/g, '\\');
    }
    return text;
  }

  private defaultDistance(direction: string): number {
    switch (direction) {
      case 'forward':
      case 'back':
        return 0.5;
      case 'left':
      case 'right':
        return 0.3;
      case 'up':
      case 'down':
        return 0.2;
      default:
        return 0.2;
    }
  }

  private async sleep(ms: number): Promise<void> {
    this.advanceExploration(0);
    await new Promise<void>((resolve) => setTimeout(resolve, Math.max(0, ms)));
    this.advanceExploration(Math.max(0, ms));
  }

  private getSimRangeDistances(pose: CrazyfliePose): Record<string, number> {
    const room = this.roomSize$.value;
    const halfW = room.width / 2;
    const halfD = room.depth / 2;

    return {
      front: Math.max(0, pose.x + halfW),
      back: Math.max(0, halfW - pose.x),
      left: Math.max(0, halfD - pose.z),
      right: Math.max(0, pose.z + halfD),
      up: Math.max(0, room.height - pose.y),
    };
  }

  private formatDistanceMeters(distance: number | null): string {
    if (distance == null || !Number.isFinite(distance)) {
      return 'none';
    }
    return distance.toFixed(3);
  }
}

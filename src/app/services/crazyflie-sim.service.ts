import { Injectable } from '@angular/core';
import { BehaviorSubject } from 'rxjs';

export type CrazyflieRoomPreset = 'classroom' | 'home' | 'custom';

export interface CrazyfliePose {
  x: number;
  y: number;
  z: number;
  yaw: number;
}

interface CrazyflieSimCommand {
  type: 'takeoff' | 'land' | 'spin_motors' | 'delay' | 'move' | 'print' | 'set_link' | 'test_link' | 'crazyflie_link' | 'test_crazyflie_link' | 'detect_flow_v2' | 'detect_multiranger' | 'mr_log_distance' | 'mr_log_all_distances' | 'detect_led_ring' | 'led_ring_set_color' | 'led_ring_set_effect' | 'led_ring_off' | 'detect_buzzer' | 'buzzer_beep';
  value?: any;
}

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
  private readonly classroomDeskHelipadPose: CrazyfliePose = { x: 0.39, y: 0.43, z: -0.43, yaw: 0 };
  private readonly baseMoveSpeedMps = 0.9;

  panelVisible$ = new BehaviorSubject<boolean>(true);
  running$ = new BehaviorSubject<boolean>(false);
  pose$ = new BehaviorSubject<CrazyfliePose>({ ...this.classroomDeskHelipadPose });
  step$ = new BehaviorSubject<CrazyflieStepEvent | null>(null);
  logs$ = new BehaviorSubject<string[]>([]);
  paused$ = new BehaviorSubject<boolean>(false);
  speed$ = new BehaviorSubject<number>(1);

  roomPreset$ = new BehaviorSubject<CrazyflieRoomPreset>('classroom');
  roomSize$ = new BehaviorSubject<{ width: number; depth: number; height: number }>({
    width: 8.2,
    depth: 6.2,
    height: 3,
  });
  floorPlanUrl$ = new BehaviorSubject<string | null>(null);
  sceneModelUrl$ = new BehaviorSubject<string | null>(null);

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
  }

  setPaused(paused: boolean): void {
    this.paused$.next(paused);
  }

  togglePause(): void {
    this.paused$.next(!this.paused$.value);
  }

  requestStepOnce(): void {
    this.stepOnceTokens += 1;
    this.paused$.next(true);
  }

  setSpeed(speed: number): void {
    const next = Math.max(0.2, Math.min(3, Number(speed) || 1));
    this.speed$.next(next);
  }

  setRoomPreset(preset: CrazyflieRoomPreset): void {
    this.roomPreset$.next(preset);
    if (preset === 'classroom') {
      this.roomSize$.next({ width: 8.2, depth: 6.2, height: 3 });
    } else if (preset === 'home') {
      this.roomSize$.next({ width: 5.5, depth: 7, height: 2.8 });
    }

    if (!this.running$.value) {
      this.pose$.next(this.getResetPoseForPreset(preset));
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
    this.pose$.next(this.getResetPoseForPreset(this.roomPreset$.value));
  }

  async runCode(code: string): Promise<{ success: boolean; message: string; executed: string[] }> {
    if (this.running$.value) {
      return { success: false, message: '模拟正在运行中', executed: [] };
    }

    const commands = this.parseCommands(code);
    if (commands.length === 0) {
      return { success: false, message: '未检测到可模拟的 Crazyflie 指令', executed: [] };
    }

    const executable = commands;
    const total = executable.length;
    const executed: string[] = [];

    this.cancelRequested = false;
    this.stepOnceTokens = 0;
    this.running$.next(true);
    this.step$.next(null);
    this.logs$.next([]);
    this.paused$.next(false);
    this.resetPose();

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

        if (command.type !== 'test_link') {
          current += 1;
          const label = this.commandLabel(command);
          this.step$.next({ current, total, label });
        }

        switch (command.type) {
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
          case 'crazyflie_link':
            this.appendLog('sim: crazyflie_link');
            executed.push('crazyflie_link');
            await this.waitWithControl(150, true);
            break;
          case 'test_crazyflie_link':
            this.appendLog('sim: test_crazyflie_link (Crazyflie Basic Test)');
            executed.push('test_crazyflie_link');
            await this.waitWithControl(200, true);
            break;
          case 'detect_flow_v2':
            this.appendLog('sim: detect_flow_v2 => true');
            executed.push('detect_flow_v2:1');
            await this.waitWithControl(180, true);
            break;
          case 'detect_multiranger':
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
            pose.y = Math.max(0.5, pose.y);
            this.pose$.next({ ...pose });
            this.appendLog('sim: takeoff');
            executed.push('takeoff');
            await this.waitWithControl(400, true);
            break;
          case 'land':
            pose.y = this.getLandingReferenceY();
            this.pose$.next({ ...pose });
            this.appendLog('sim: land');
            executed.push('land');
            await this.waitWithControl(400, true);
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
      this.step$.next(null);
      this.paused$.next(false);

      if (cancelled) {
        this.appendLog('sim: cancelled');
        return { success: false, message: '模拟已取消', executed };
      }

      this.appendLog('sim: finished');
      return { success: true, message: '模拟执行完成', executed };
    } catch (error: any) {
      this.running$.next(false);
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
    if (preset === 'classroom') {
      return { ...this.classroomDeskHelipadPose };
    }
    return { ...this.originPose };
  }

  private getLandingReferenceY(): number {
    return Math.max(0.06, this.getResetPoseForPreset(this.roomPreset$.value).y);
  }

  private applyMove(pose: CrazyfliePose, direction: string, distance: number): void {
    switch (direction) {
      case 'forward':
        pose.x -= distance;
        break;
      case 'back':
        pose.x += distance;
        break;
      case 'left':
        pose.z += distance;
        break;
      case 'right':
        pose.z -= distance;
        break;
      case 'up':
        pose.y += distance;
        break;
      case 'down':
        pose.y = Math.max(this.getLandingReferenceY(), pose.y - distance);
        break;
      default:
        break;
    }
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

      const setLinkMatch = /^cf_set_link\s*\(\s*['\"](.*?)['\"]\s*,\s*['\"](.*?)['\"]\s*\)\s*;?$/.exec(line);
      if (setLinkMatch) {
        commands.push({ type: 'set_link', value: { uri: setLinkMatch[1], address: setLinkMatch[2] } });
        continue;
      }

      if (/^cf_test_link\s*\(/.test(line)) {
        commands.push({ type: 'test_link' });
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

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
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

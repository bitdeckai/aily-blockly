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
  type: 'takeoff' | 'land' | 'delay' | 'move' | 'print' | 'test_link';
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

    const executable = commands.filter((item) => item.type !== 'test_link');
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
          case 'test_link':
            this.appendLog('sim: test_link');
            executed.push('test_link');
            break;
          case 'takeoff':
            pose.y = Math.max(0.5, pose.y);
            this.pose$.next({ ...pose });
            this.appendLog('sim: takeoff');
            executed.push('takeoff');
            await this.waitWithControl(400, true);
            break;
          case 'land':
            pose.y = 0.06;
            this.pose$.next({ ...pose });
            this.appendLog('sim: land');
            executed.push('land');
            await this.waitWithControl(400, true);
            break;
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
            this.applyMove(pose, direction, distance);
            this.pose$.next({ ...pose });
            this.appendLog(`sim: move ${direction} ${distance}m`);
            executed.push(`move:${direction}:${distance}`);
            await this.waitWithControl(500, true);
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

  private applyMove(pose: CrazyfliePose, direction: string, distance: number): void {
    switch (direction) {
      case 'forward':
        pose.z -= distance;
        break;
      case 'back':
        pose.z += distance;
        break;
      case 'left':
        pose.x -= distance;
        break;
      case 'right':
        pose.x += distance;
        break;
      case 'up':
        pose.y += distance;
        break;
      case 'down':
        pose.y = Math.max(0.06, pose.y - distance);
        break;
      default:
        break;
    }
  }

  private commandLabel(command: CrazyflieSimCommand): string {
    switch (command.type) {
      case 'takeoff':
        return 'takeoff';
      case 'land':
        return 'land';
      case 'delay':
        return `delay:${Number(command.value || 0)}`;
      case 'print':
        return `print:${String(command.value || '')}`;
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

      if (/^cf_test_link\s*\(/.test(line)) {
        commands.push({ type: 'test_link' });
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
}

import { Injectable, OnDestroy } from '@angular/core';
import { Subscription } from 'rxjs';
import type { GestureRecognizer } from '@mediapipe/tasks-vision';
import { AiDeckCameraService } from './ai-deck-camera.service';
import { parseAiDeckCameraCall, validateAiDeckCameraSequence } from './ai-deck-camera';
import { CameraGestureBinding, CameraPalmSwipe, parseCameraGestureCall, recognizeCameraStaticGesture, StableCameraGesture, validateCameraGestureProgram } from './camera-gesture';
import { CrazyflieRuntimePolicy, CrazyflieRuntimeService } from './crazyflie-runtime.service';
import { CrazyflieConnectionService } from './crazyflie-connection.service';
import { NoticeService } from './notice.service';
import { TranslateService } from '@ngx-translate/core';

export interface CameraGestureExecutor {
  run(binding: CameraGestureBinding, policy: CrazyflieRuntimePolicy): Promise<void>;
  cancel(policy: CrazyflieRuntimePolicy): Promise<void>;
  interrupt(binding: CameraGestureBinding, policy: CrazyflieRuntimePolicy): Promise<boolean>;
}

@Injectable({ providedIn: 'root' })
export class CameraGestureService implements OnDestroy {
  private readonly subscriptions = new Subscription();
  private readonly tracker = new StableCameraGesture();
  private readonly swipeTracker = new CameraPalmSwipe();
  private readonly bindings = new Map<string, CameraGestureBinding>();
  private recognizer: GestureRecognizer | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private generation = 0;
  private programVersion = 0;
  private executor: CameraGestureExecutor | null = null;
  private action: Promise<void> | null = null;
  private actionPolicy: CrazyflieRuntimePolicy | null = null;
  private authorizationTarget = '';
  programRunning = false;
  private readonly onVisibility = () => {
    if (document.hidden) void this.stop().catch(error => this.report(error));
  };

  constructor(
    private camera: AiDeckCameraService,
    private runtime: CrazyflieRuntimeService,
    private connection: CrazyflieConnectionService,
    private notice: NoticeService,
    private translate: TranslateService,
  ) {
    camera.gestures = this;
    this.subscriptions.add(runtime.policy$.subscribe(policy => {
      camera.gestureState$.next({ ...camera.gestureState$.value, realMode: policy !== 'sim-only', authorized: false });
      if (this.recognizer || this.action || camera.gestureState$.value.phase === 'loading') {
        void this.stop().catch(error => this.report(error));
      }
    }));
    this.subscriptions.add(connection.state$.subscribe(state => {
      if (state.status !== 'ready' || this.authorizationTarget !== this.target()) {
        camera.gestureState$.next({ ...camera.gestureState$.value, authorized: false });
        if (this.actionPolicy && this.actionPolicy !== 'sim-only') void this.stop().catch(error => this.report(error));
      }
    }));
    this.subscriptions.add(camera.command$.subscribe(command => {
      if (command && (this.recognizer || this.action || camera.gestureState$.value.authorized
        || camera.gestureState$.value.phase === 'loading')) {
        void this.stop().catch(error => this.report(error));
      }
    }));
    document.addEventListener('visibilitychange', this.onVisibility);
  }

  setExecutor(executor: CameraGestureExecutor): void { this.executor = executor; }
  private target(): string {
    const state = this.connection.state$.value;
    return `${this.runtime.policy$.value}:${state.uri || ''}:${state.radioSerial || ''}`;
  }

  authorize(enabled: boolean): void {
    if (enabled && (this.runtime.policy$.value === 'sim-only' || this.connection.state$.value.status !== 'ready'
      || this.connection.state$.value.busy || this.connection.flightReadiness$.value.status !== 'ready')) {
      this.report(new Error('CAMERA_GESTURE.CONNECT_FIRST'));
      return;
    }

    this.authorizationTarget = enabled ? this.target() : '';
    this.camera.gestureState$.next({ ...this.camera.gestureState$.value, authorized: enabled });
    if (!enabled && this.action) void this.cancelAction().catch(error => this.report(error));
  }

  realAllowed(policy: CrazyflieRuntimePolicy): boolean {
    return policy !== 'sim-only' && this.runtime.policy$.value === policy
      && this.camera.gestureState$.value.authorized && this.authorizationTarget === this.target()
      && this.connection.state$.value.status === 'ready';
  }

  async start(): Promise<void> {
    if (this.camera.gestureState$.value.phase === 'running') return;
    const source = this.camera.frameSource;
    if (!source) throw new Error('CAMERA_GESTURE.OPEN_FIRST');
    const epoch = ++this.generation;
    this.camera.gestureState$.next({ ...this.camera.gestureState$.value, phase: 'loading', error: '', gesture: null });
    let recognizer: GestureRecognizer | null = null;
    try {
      const image = await source.prepareForRecognition();
      const { FilesetResolver, GestureRecognizer } = await import('@mediapipe/tasks-vision');
      const root = source.recognitionAssetRoot();
      const files = await FilesetResolver.forVisionTasks(root, false);
      recognizer = await GestureRecognizer.createFromOptions(files, {
        baseOptions: { modelAssetPath: `${root}/gesture_recognizer.task`, delegate: 'CPU' },
        runningMode: 'VIDEO', numHands: 2, minHandDetectionConfidence: 0.7, minHandPresenceConfidence: 0.7,
      });
      if (epoch !== this.generation || this.camera.frameSource !== source) { recognizer.close(); return; }
      this.recognizer = recognizer;
      this.tracker.reset();
      this.swipeTracker.reset();
      this.camera.gestureState$.next({ ...this.camera.gestureState$.value, phase: 'running', error: '' });
      const tick = async () => {
        if (epoch !== this.generation) return;
        try {
          if (this.camera.frameSource !== source || !await source.frameIsFresh()) throw new Error('CAMERA_GESTURE.STALE_VIDEO');
          if (epoch !== this.generation) return;
          const result = recognizer!.recognizeForVideo(image, performance.now());
          const gesture = recognizeCameraStaticGesture(result);
          const now = performance.now();
          const holdFor = (name: string) => Math.max(this.bindings.get(name)?.holdSeconds || 1.2,
            this.runtime.policy$.value === 'sim-only' ? 0.5 : 1.2) * 1000;
          const swipe = this.swipeTracker.update(gesture, result.landmarks?.[0], now, holdFor);
          this.camera.gestureState$.next({ ...this.camera.gestureState$.value, gesture: swipe?.gesture || gesture });
          const binding = gesture ? this.bindings.get(gesture) : undefined;
          const hold = Math.max(binding?.holdSeconds || 1.2, this.runtime.policy$.value === 'sim-only' ? 0.5 : 1.2);
          const event = this.tracker.update(gesture, now, hold * 1000);
          if (swipe) {
            this.camera.gesture$.next({ ...swipe, timestamp: Date.now() });
            const swipeBinding = this.bindings.get(swipe.gesture);
            if (swipeBinding) void this.dispatch(swipeBinding).catch(error => this.report(error));
          }
          if (event) {
            this.camera.gesture$.next({ gesture: event, heldSeconds: this.tracker.heldSeconds(now), timestamp: Date.now() });
            if (binding) void this.dispatch(binding).catch(error => this.report(error));
          }
          if (epoch === this.generation) this.timer = setTimeout(tick, 250);
        } catch (error) {
          await this.stop().catch(cancelError => this.report(cancelError));
          this.report(error);
        }
      };
      void tick();
    } catch (error) {
      recognizer?.close();
      if (epoch !== this.generation) return;
      this.camera.gestureState$.next({ ...this.camera.gestureState$.value, phase: 'error', error: this.errorText(error) });
      throw error;
    }
  }

  private async dispatch(binding: CameraGestureBinding): Promise<void> {
    if (!binding.code.trim()) return;
    const policy = this.runtime.policy$.value;
    if (!this.executor) throw new Error('CAMERA_GESTURE.RUN_PROGRAM');
    if (policy !== 'sim-only' && !this.realAllowed(policy)) {
      throw new Error('CAMERA_GESTURE.AUTHORIZATION_REQUIRED');
    }
    const currentAction = this.action;
    if (currentAction) {
      if (this.actionPolicy && await this.executor.interrupt(binding, this.actionPolicy)) {
        await currentAction;
        return;
      }
      throw new Error('CAMERA_GESTURE.BUSY');
    }
    this.actionPolicy = policy;
    const action = this.executor.run(binding, policy);
    this.action = action;
    try { await action; }
    finally { this.action = null; this.actionPolicy = null; }
  }

  private async cancelAction(): Promise<void> {
    if (!this.action || !this.actionPolicy || !this.executor) return;
    const action = this.action;
    await this.executor.cancel(this.actionPolicy);
    await action;
  }

  async stop(): Promise<void> {
    this.generation++;
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    const recognizer = this.recognizer;
    this.recognizer = null;
    this.tracker.reset();
    this.swipeTracker.reset();
    this.authorizationTarget = '';
    this.camera.gestureState$.next({ ...this.camera.gestureState$.value, phase: 'idle', gesture: null, authorized: false, error: '' });
    try { recognizer?.close(); }
    finally { await this.cancelAction(); }
  }

  cancelProgram(): void { this.programVersion++; }
  clearProgram(): void {
    this.cancelProgram();
    this.bindings.clear();
    void this.stop().catch(error => this.report(error));
  }

  async runProgram(code: string, onStep: (index: number) => void): Promise<void> {
    if (this.programRunning || this.action) throw new Error('CAMERA_GESTURE.BUSY');
    validateCameraGestureProgram(code);
    validateAiDeckCameraSequence(code);
    await this.stop();
    const lines = code.split(/\r?\n/).map(line => line.trim()).filter(line => line && !line.startsWith('#'));
    this.bindings.clear();
    for (const line of lines) {
      const command = parseCameraGestureCall(line);
      if (command?.type === 'on') this.bindings.set(command.binding.gesture, command.binding);
    }
    const version = ++this.programVersion;
    this.programRunning = true;
    try {
      for (let index = 0; index < lines.length; index++) {
        if (version !== this.programVersion) throw new Error('CAMERA_GESTURE.PROGRAM_CANCELLED');
        const line = lines[index];
        onStep(index);
        const command = parseCameraGestureCall(line);
        if (command?.type === 'on') continue;
        if (command?.type === 'start') { await this.start(); continue; }
        if (command?.type === 'stop') { await this.stop(); continue; }
        const camera = parseAiDeckCameraCall(line);
        if (camera) { this.camera.execute(camera); continue; }
        const delay = /^cf_delay\(([0-9]*\.?[0-9]+)\)\s*;?$/.exec(line);
        if (delay) {
          const seconds = Number(delay[1]);
          if (!Number.isFinite(seconds) || seconds > 3600) throw new Error('CAMERA_GESTURE.INVALID_PROGRAM');
          const until = performance.now() + seconds * 1000;
          while (performance.now() < until) {
            if (version !== this.programVersion) throw new Error('CAMERA_GESTURE.PROGRAM_CANCELLED');
            await new Promise(resolve => setTimeout(resolve, 100));
          }
          continue;
        }
        const print = /^cf_print\(("(?:[^"\\]|\\.)*")\)\s*;?$/.exec(line);
        if (print) { console.info('Camera gesture program:', JSON.parse(print[1])); continue; }
        throw new Error('CAMERA_GESTURE.INVALID_PROGRAM');
      }
    } finally { this.programRunning = false; }
  }

  private errorText(error: unknown): string {
    return this.translate.instant(error instanceof Error ? error.message : String(error));
  }
  private report(error: unknown): void {
    const text = this.errorText(error);
    console.warn('Camera gesture:', text);
    this.camera.gestureState$.next({ ...this.camera.gestureState$.value, error: text });
    this.notice.update({ title: this.translate.instant('CAMERA_GESTURE.TITLE'), text, state: 'error' });
  }

  ngOnDestroy(): void {
    this.clearProgram();
    this.subscriptions.unsubscribe();
    document.removeEventListener('visibilitychange', this.onVisibility);
    this.camera.gestures = null;
  }
}

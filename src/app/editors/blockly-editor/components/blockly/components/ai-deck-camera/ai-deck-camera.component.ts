import { AfterViewInit, ChangeDetectorRef, Component, ElementRef, EventEmitter, Input, OnChanges, OnDestroy, Output, SimpleChanges, ViewChild, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { TranslateModule } from '@ngx-translate/core';

import { AiDeckCameraCommand, aiDeckStreamUrl } from '../../../../../../services/ai-deck-camera';
import { cameraFrameProxyApi } from '../../../../../../services/camera-frame-proxy';
import type { CameraGestureState } from '../../../../../../services/camera-gesture';
export { aiDeckStreamUrl } from '../../../../../../services/ai-deck-camera';

@Component({
  selector: 'app-ai-deck-camera',
  standalone: true,
  imports: [CommonModule, TranslateModule],
  template: `
    <section #panel class="ai-camera" [attr.aria-label]="'AI_DECK_CAMERA.TITLE' | translate">
      <header>
        <strong>{{ 'AI_DECK_CAMERA.TITLE' | translate }}</strong>
        <div class="ai-camera__sizes">
          <button type="button" (click)="resized.emit(-80)" [disabled]="previewWidth <= 240"
            [attr.aria-label]="'AI_DECK_CAMERA.ZOOM_OUT' | translate">−</button>
          <button type="button" (click)="resized.emit(80)" [disabled]="previewWidth >= 640"
            [attr.aria-label]="'AI_DECK_CAMERA.ZOOM_IN' | translate">+</button>
          <button type="button" (click)="closePreview()"
            [attr.aria-label]="'AI_DECK_CAMERA.CLOSE_VIDEO' | translate">×</button>
        </div>
      </header>
      <form (submit)="connect($event)">
        <input type="text" [value]="address" (input)="changeAddress($event)"
          [attr.aria-label]="'AI_DECK_CAMERA.ADDRESS' | translate"
          [disabled]="state === 'connecting' || state === 'connected'" placeholder="192.168.4.1"
          autocomplete="off" spellcheck="false">
        <button type="submit" [disabled]="state === 'connecting' || state === 'connected'">
          {{ 'AI_DECK_CAMERA.OPEN_VIDEO' | translate }}
        </button>
        <button type="button" (click)="closePreview()" [disabled]="!streamUrl">
          {{ 'AI_DECK_CAMERA.CLOSE_VIDEO' | translate }}
        </button>
      </form>
      <div class="ai-camera__status" role="status">{{ statusKey | translate }}</div>
      <div class="ai-camera__error" *ngIf="errorKey" role="alert">{{ errorKey | translate }}</div>
      <div class="ai-camera__viewport" *ngIf="streamUrl">
        <img #image [attr.crossorigin]="readable ? 'anonymous' : null" [src]="streamUrl" [alt]="'AI_DECK_CAMERA.TITLE' | translate"
          referrerpolicy="no-referrer" (load)="checkFrame()" (error)="imageError()">
      </div>
      <div class="ai-camera__gestures">
        <button type="button" (click)="gestureControl.emit('start')" [disabled]="!streamUrl || gestureState.phase === 'loading' || gestureState.phase === 'running'">
          {{ 'CAMERA_GESTURE.START' | translate }}
        </button>
        <button type="button" (click)="gestureControl.emit('stop')" [disabled]="gestureState.phase === 'idle'">
          {{ 'CAMERA_GESTURE.STOP' | translate }}
        </button>
        <span>{{ ('CAMERA_GESTURE.' + (gestureState.gesture || gestureState.phase.toUpperCase())) | translate }}</span>
        <label *ngIf="gestureState.realMode">
          <input type="checkbox" [checked]="gestureState.authorized"
            (change)="requestAuthorization($event)">
          {{ 'CAMERA_GESTURE.AUTHORIZE' | translate }}
        </label>
        <div *ngIf="gestureState.error" role="alert">{{ gestureState.error }}</div>
      </div>
      <details><summary>{{ 'AI_DECK_CAMERA.HELP' | translate }}</summary>
        <p>{{ 'AI_DECK_CAMERA.NOTICE' | translate }}</p>
      </details>
    </section>
  `,
  styles: [`
    :host { display: block; min-width: 0; }
    .ai-camera__sizes { display: flex; gap: 4px; }
    .ai-camera__gestures { display: flex; flex-wrap: wrap; gap: 5px; align-items: center; margin-top: 6px; }
    .ai-camera__gestures label { flex-basis: 100%; }
    .ai-camera__gestures input { flex: none; }
    .ai-camera { box-sizing: border-box; padding: 8px; border: 1px solid var(--aily-border-primary, #536479);
      border-radius: 6px; background: var(--aily-bg-secondary, #323437); color: var(--aily-text-primary, #fff);
      font-size: 12px; line-height: 1.5; }
    form { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; }
    header { display: flex; justify-content: space-between; align-items: center; gap: 8px; margin-bottom: 6px; }
    header button { padding: 0 7px; }
    input { flex: 1 1 130px; min-width: 0; padding: 5px 7px; border: 1px solid var(--aily-border-input, #777);
      border-radius: 4px; background: var(--aily-bg-primary, #222); color: inherit; }
    button { padding: 5px 8px; border: 1px solid var(--aily-border-input, #777); border-radius: 4px;
      background: var(--aily-bg-tertiary, #444); color: inherit; cursor: pointer; }
    button:disabled { opacity: .5; cursor: not-allowed; }
    input:focus-visible, button:focus-visible { outline: 2px solid #429bcc; outline-offset: 1px; }
    .ai-camera__status, p { margin: 4px 0 0; }
    .ai-camera__error { border-inline-start: 3px solid var(--aily-color-error-bright, #ff9696);
      padding-inline-start: 6px; font-weight: 600; overflow-wrap: anywhere; }
    .ai-camera__viewport { margin-top: 6px; background: #101820; border-radius: 4px; overflow: hidden; }
    img { display: block; width: 100%; aspect-ratio: 4 / 3; object-fit: contain; }
  `],
})
export class AiDeckCameraComponent implements OnChanges, AfterViewInit, OnDestroy {
  private readonly cdr = inject(ChangeDetectorRef);
  @Input() address = '';
  @Input() command: AiDeckCameraCommand | null = null;
  @Input() previewWidth = 320;
  @Input() gestureState: CameraGestureState = { phase: 'idle', gesture: null, authorized: false, realMode: false, error: '' };
  @Output() gestureControl = new EventEmitter<'start' | 'stop' | 'authorize' | 'disarm'>();
  @Output() connectRequested = new EventEmitter<void>();
  @Output() opening = new EventEmitter<void>();
  @Output() resized = new EventEmitter<number>();
  @Output() heightChange = new EventEmitter<number>();
  @Output() addressChange = new EventEmitter<string>();
  @Output() closed = new EventEmitter<void>();
  @ViewChild('image') image?: ElementRef<HTMLImageElement>;
  @ViewChild('panel') panel?: ElementRef<HTMLElement>;
  state: 'idle' | 'connecting' | 'connected' | 'error' = 'idle';
  streamUrl = '';
  readable = false;
  errorKey = '';
  private frameTimer: ReturnType<typeof setInterval> | null = null;
  private timeout: ReturnType<typeof setTimeout> | null = null;
  private resizeObserver: ResizeObserver | null = null;
  private proxyUrl = '';
  private proxyEpoch = 0;

  async prepareForRecognition(): Promise<HTMLImageElement> {
    if (!this.streamUrl || !this.image) throw new Error('CAMERA_GESTURE.OPEN_FIRST');
    if (!this.proxyUrl) {
      const epoch = ++this.proxyEpoch;
      const api = cameraFrameProxyApi();
      const result = await api.start(this.streamUrl);
      if (!result.success || !result.url) throw new Error(result.message || 'CAMERA_GESTURE.PROXY_FAILED');
      const url = new URL(result.url);
      if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1') throw new Error('CAMERA_GESTURE.PROXY_FAILED');
      if (epoch !== this.proxyEpoch || !this.streamUrl) { await api.stop(result.url); throw new Error('CAMERA_GESTURE.OPEN_FIRST'); }
      this.clearTimers();
      this.image.nativeElement.removeAttribute('src');
      this.proxyUrl = result.url;
      this.readable = true;
      this.image.nativeElement.crossOrigin = 'anonymous';
      this.streamUrl = result.url;
      this.image.nativeElement.src = result.url;
      this.state = 'connecting';
      this.frameTimer = setInterval(() => this.checkFrame(), 100);
      this.timeout = setTimeout(() => this.fail('AI_DECK_CAMERA.TIMEOUT'), 8000);
      this.cdr.markForCheck();
    }
    const epoch = this.proxyEpoch;
    const deadline = Date.now() + 8500;
    while (epoch === this.proxyEpoch && Date.now() < deadline) {
      if (this.state === 'connected' && this.image?.nativeElement.naturalWidth) return this.image.nativeElement;
      if (this.state === 'error') throw new Error(this.errorKey);
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw new Error('CAMERA_GESTURE.OPEN_FIRST');
  }

  async frameIsFresh(): Promise<boolean> {
    if (!this.proxyUrl || this.state !== 'connected') return false;
    const result = await cameraFrameProxyApi().status(this.proxyUrl);
    return result.success && typeof result.lastDataAt === 'number' && Date.now() - result.lastDataAt < 1000;
  }

  recognitionAssetRoot(): string {
    if (!this.proxyUrl) throw new Error('CAMERA_GESTURE.OPEN_FIRST');
    return this.proxyUrl.replace('/stream/', '/vision/');
  }

  ngAfterViewInit(): void {
    if (!this.panel) return;
    const element = this.panel.nativeElement;
    this.resizeObserver = new ResizeObserver(([entry]) =>
      this.heightChange.emit(entry.borderBoxSize[0]?.blockSize || element.offsetHeight));
    this.resizeObserver.observe(element);
  }

  ngOnChanges(changes: SimpleChanges): void {
    if (!changes['command'] || !this.command) return;
    if (this.command.type === 'configure') {
      this.disconnect();
      this.address = this.command.address;
    } else if (this.command.type === 'open') {
      this.connect();
    } else {
      this.disconnect();
    }
  }

  get statusKey(): string {
    return `AI_DECK_CAMERA.${this.state === 'connecting' ? 'CONNECTING' : this.state === 'connected' ? 'CONNECTED' : 'IDLE'}`;
  }

  changeAddress(event: Event): void {
    if (event.target instanceof HTMLInputElement) this.address = event.target.value;
  }

  requestAuthorization(event: Event): void {
    if (!(event.target instanceof HTMLInputElement)) return;
    this.gestureControl.emit(event.target.checked ? 'authorize' : 'disarm');
    event.target.checked = this.gestureState.authorized;
  }

  closePreview(): void {
    this.disconnect();
    this.closed.emit();
  }

  connect(event?: Event): void {
    event?.preventDefault();
    this.connectRequested.emit();
    this.disconnect();
    try {
      this.streamUrl = aiDeckStreamUrl(this.address);
    } catch (error) {
      this.fail('AI_DECK_CAMERA.INVALID_ADDRESS', error);
      return;
    }
    this.address = this.address.trim();
    this.addressChange.emit(this.address);
    this.opening.emit();
    this.state = 'connecting';
    // Multipart image load events vary; an actual decoded frame is the readiness signal.
    this.frameTimer = setInterval(() => this.checkFrame(), 100);
    this.timeout = setTimeout(() => this.fail('AI_DECK_CAMERA.TIMEOUT'), 8000);
    this.cdr.markForCheck();
  }

  checkFrame(): void {
    if (this.state !== 'connecting' || !this.image?.nativeElement.naturalWidth) return;
    this.state = 'connected';
    this.clearTimers();
    this.cdr.markForCheck();
  }

  imageError(): void {
    if (this.streamUrl) this.fail('AI_DECK_CAMERA.STREAM_ERROR');
  }

  disconnect(): void {
    if (this.streamUrl && (this.gestureState.phase === 'loading' || this.gestureState.phase === 'running')) {
      this.gestureControl.emit('stop');
    }
    this.proxyEpoch++;
    if (this.proxyUrl) {
      const url = this.proxyUrl;
      const epoch = this.proxyEpoch;
      this.proxyUrl = '';
      void cameraFrameProxyApi().stop(url).then(result => {
        if (!result.success) throw new Error(result.message || 'CAMERA_GESTURE.PROXY_FAILED');
      }).catch(error => {
        console.warn('Camera preview cleanup failed:', error instanceof Error ? error.message : String(error));
        if (epoch === this.proxyEpoch) this.fail('CAMERA_GESTURE.PROXY_FAILED', error);
      });
    }
    this.readable = false;
    this.clearTimers();
    this.streamUrl = '';
    this.image?.nativeElement.removeAttribute('src');
    this.state = 'idle';
    this.errorKey = '';
    this.cdr.markForCheck();
  }

  ngOnDestroy(): void {
    this.resizeObserver?.disconnect();
    this.disconnect();
  }

  private clearTimers(): void {
    if (this.frameTimer !== null) clearInterval(this.frameTimer);
    if (this.timeout !== null) clearTimeout(this.timeout);
    this.frameTimer = null;
    this.timeout = null;
  }

  private fail(key: string, error?: unknown): void {
    this.disconnect();
    this.state = 'error';
    this.errorKey = key;
    this.cdr.markForCheck();
    console.warn('AI Deck camera:', key, error instanceof Error ? error.message : '');
  }
}

import { Component, ElementRef, EventEmitter, Input, OnChanges, OnDestroy, Output, SimpleChanges, ViewChild } from '@angular/core';
import { CommonModule } from '@angular/common';
import { TranslateModule } from '@ngx-translate/core';

import { AiDeckCameraCommand, aiDeckStreamUrl } from '../../../../../../services/ai-deck-camera';
export { aiDeckStreamUrl } from '../../../../../../services/ai-deck-camera';

@Component({
  selector: 'app-ai-deck-camera',
  standalone: true,
  imports: [CommonModule, TranslateModule],
  template: `
    <section class="ai-camera" [attr.aria-label]="'AI_DECK_CAMERA.TITLE' | translate">
      <header>
        <strong>{{ 'AI_DECK_CAMERA.TITLE' | translate }}</strong>
        <button type="button" (click)="closed.emit()" [attr.aria-label]="'AI_DECK_CAMERA.CLOSE_PANEL' | translate">×</button>
      </header>
      <form (submit)="connect($event)">
        <label for="ai-deck-address">{{ 'AI_DECK_CAMERA.ADDRESS' | translate }}</label>
        <input id="ai-deck-address" type="text" [value]="address" (input)="changeAddress($event)"
          [disabled]="state === 'connecting' || state === 'connected'" placeholder="192.168.4.1"
          autocomplete="off" spellcheck="false">
        <button type="submit" [disabled]="state === 'connecting' || state === 'connected'">
          {{ 'AI_DECK_CAMERA.CONNECT' | translate }}
        </button>
        <button type="button" (click)="disconnect()" [disabled]="!streamUrl">
          {{ 'AI_DECK_CAMERA.DISCONNECT' | translate }}
        </button>
      </form>
      <div class="ai-camera__status" role="status">{{ statusKey | translate }}</div>
      <div class="ai-camera__error" *ngIf="errorKey" role="alert">{{ errorKey | translate }}</div>
      <div class="ai-camera__viewport" *ngIf="streamUrl">
        <img #image [src]="streamUrl" [alt]="'AI_DECK_CAMERA.TITLE' | translate"
          referrerpolicy="no-referrer" (load)="checkFrame()" (error)="imageError()">
      </div>
      <p>{{ 'AI_DECK_CAMERA.NOTICE' | translate }}</p>
    </section>
  `,
  styles: [`
    :host { display: block; min-width: 0; }
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
    img { display: block; width: 100%; height: min(180px, 30vh); object-fit: contain; }
  `],
})
export class AiDeckCameraComponent implements OnChanges, OnDestroy {
  @Input() address = '';
  @Input() command: AiDeckCameraCommand | null = null;
  @Output() addressChange = new EventEmitter<string>();
  @Output() closed = new EventEmitter<void>();
  @ViewChild('image') image?: ElementRef<HTMLImageElement>;
  state: 'idle' | 'connecting' | 'connected' | 'error' = 'idle';
  streamUrl = '';
  errorKey = '';
  private frameTimer: ReturnType<typeof setInterval> | null = null;
  private timeout: ReturnType<typeof setTimeout> | null = null;

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

  connect(event?: Event): void {
    event?.preventDefault();
    this.disconnect();
    try {
      this.streamUrl = aiDeckStreamUrl(this.address);
    } catch (error) {
      this.fail('AI_DECK_CAMERA.INVALID_ADDRESS', error);
      return;
    }
    this.address = this.address.trim();
    this.addressChange.emit(this.address);
    this.state = 'connecting';
    // Multipart image load events vary; an actual decoded frame is the readiness signal.
    this.frameTimer = setInterval(() => this.checkFrame(), 100);
    this.timeout = setTimeout(() => this.fail('AI_DECK_CAMERA.TIMEOUT'), 8000);
  }

  checkFrame(): void {
    if (this.state !== 'connecting' || !this.image?.nativeElement.naturalWidth) return;
    this.state = 'connected';
    this.clearTimers();
  }

  imageError(): void {
    if (this.streamUrl) this.fail('AI_DECK_CAMERA.STREAM_ERROR');
  }

  disconnect(): void {
    this.clearTimers();
    this.streamUrl = '';
    this.image?.nativeElement.removeAttribute('src');
    this.state = 'idle';
    this.errorKey = '';
  }

  ngOnDestroy(): void { this.disconnect(); }

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
    console.warn('AI Deck camera:', key, error instanceof Error ? error.message : '');
  }
}

import { Injectable } from '@angular/core';
import { BehaviorSubject } from 'rxjs';
import { AiDeckCameraCommand, aiDeckStreamUrl } from './ai-deck-camera';

@Injectable({ providedIn: 'root' })
export class AiDeckCameraService {
  readonly visible$ = new BehaviorSubject(false);
  readonly address$ = new BehaviorSubject('');
  readonly command$ = new BehaviorSubject<AiDeckCameraCommand | null>(null);

  showPanel(): void {
    if (this.visible$.value) return;
    this.command$.next(null);
    this.visible$.next(true);
  }

  hidePanel(): void {
    this.command$.next({ type: 'close' });
    this.visible$.next(false);
    this.command$.next(null);
  }

  execute(command: AiDeckCameraCommand): void {
    if (command.type === 'configure') {
      aiDeckStreamUrl(command.address);
      this.address$.next(command.address);
    }
    if (command.type === 'open') {
      aiDeckStreamUrl(this.address$.value);
      this.visible$.next(true);
    }
    this.command$.next(command);
  }
}

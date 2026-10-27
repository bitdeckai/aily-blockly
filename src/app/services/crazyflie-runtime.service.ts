import { Injectable } from '@angular/core';
import { BehaviorSubject } from 'rxjs';

export type CrazyflieRuntimePolicy = 'sim-only' | 'sim-real' | 'real-only';

@Injectable({
  providedIn: 'root',
})
export class CrazyflieRuntimeService {
  policy$ = new BehaviorSubject<CrazyflieRuntimePolicy>('sim-only');

  setPolicy(policy: CrazyflieRuntimePolicy): void {
    this.policy$.next(policy);
  }

  cyclePolicy(): CrazyflieRuntimePolicy {
    const current = this.policy$.value;
    const next: CrazyflieRuntimePolicy = current === 'sim-only'
      ? 'sim-real'
      : current === 'sim-real'
        ? 'real-only'
        : 'sim-only';
    this.policy$.next(next);
    return next;
  }

}

import { Injectable } from '@angular/core';
import { BehaviorSubject } from 'rxjs';

export type CrazyflieRuntimePolicy = 'sim-only' | 'sim-first' | 'real-only';

@Injectable({
  providedIn: 'root',
})
export class CrazyflieRuntimeService {
  policy$ = new BehaviorSubject<CrazyflieRuntimePolicy>('sim-first');
  lastSimulationPassed$ = new BehaviorSubject<boolean>(false);

  setPolicy(policy: CrazyflieRuntimePolicy): void {
    this.policy$.next(policy);
  }

  cyclePolicy(): CrazyflieRuntimePolicy {
    const current = this.policy$.value;
    const next: CrazyflieRuntimePolicy = current === 'sim-only'
      ? 'sim-first'
      : current === 'sim-first'
        ? 'real-only'
        : 'sim-only';
    this.policy$.next(next);
    return next;
  }

  markSimulationResult(success: boolean): void {
    this.lastSimulationPassed$.next(!!success);
  }

  resetSimulationGate(): void {
    this.lastSimulationPassed$.next(false);
  }
}

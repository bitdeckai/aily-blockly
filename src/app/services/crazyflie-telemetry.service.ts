import { Injectable } from '@angular/core';
import { BehaviorSubject } from 'rxjs';

export interface CrazyflieTelemetryState {
  batteryPercent: number | null;
  batteryVolts: number | null;
  linkQuality: number | null;
  updatedAt: number;
}

@Injectable({
  providedIn: 'root',
})
export class CrazyflieTelemetryService {
  readonly telemetry$ = new BehaviorSubject<CrazyflieTelemetryState | null>(null);

  setTelemetry(data: Partial<CrazyflieTelemetryState>): void {
    const current = this.telemetry$.value;
    this.telemetry$.next({
      batteryPercent: this.normalizePercent('batteryPercent' in data ? data.batteryPercent : current?.batteryPercent),
      batteryVolts: this.normalizeVolts('batteryVolts' in data ? data.batteryVolts : current?.batteryVolts),
      linkQuality: this.normalizePercent('linkQuality' in data ? data.linkQuality : current?.linkQuality),
      updatedAt: Date.now(),
    });
  }

  clear(): void {
    this.telemetry$.next(null);
  }

  private normalizePercent(input: any): number | null {
    if (input === null || input === undefined || input === '') return null;
    const value = Number(input);
    if (!Number.isFinite(value)) {
      return null;
    }
    return Math.max(0, Math.min(100, Math.round(value)));
  }

  private normalizeVolts(input: any): number | null {
    if (input === null || input === undefined || input === '') return null;
    const value = Number(input);
    if (!Number.isFinite(value)) {
      return null;
    }
    return Math.max(0, Math.min(6, Number(value.toFixed(3))));
  }
}

import { Injectable } from '@angular/core';
import { BehaviorSubject } from 'rxjs';

export type CrazyflieConnectionStatus = 'unknown' | 'checking' | 'ready' | 'error' | 'disconnected';

export interface CrazyflieConnectionState {
  status: CrazyflieConnectionStatus;
  message: string;
  updatedAt: number | null;
}

@Injectable({
  providedIn: 'root',
})
export class CrazyflieConnectionService {
  readonly state$ = new BehaviorSubject<CrazyflieConnectionState>({
    status: 'unknown',
    message: '尚未检测',
    updatedAt: null,
  });

  setChecking(): void {
    this.state$.next({ status: 'checking', message: '正在检测无线链路…', updatedAt: Date.now() });
  }

  setResult(success: boolean, message?: string): void {
    this.state$.next({
      status: success ? 'ready' : 'error',
      message: message || (success ? 'Crazyradio 已就绪' : '无线链路检测失败'),
      updatedAt: Date.now(),
    });
  }

  disconnect(): void {
    this.state$.next({ status: 'disconnected', message: '连接已断开', updatedAt: Date.now() });
  }

  async checkLink(): Promise<CrazyflieConnectionState> {
    this.setChecking();
    try {
      const api = (window as any).crazyflie;
      if (!api || typeof api.testLink !== 'function') {
        throw new Error('未找到 Crazyflie 链路检测接口');
      }

      const result = await api.testLink({
        timeoutMs: 5000,
        uri: 'radio://0/80/2M',
        addressHex: 'E7E7E7E7E7',
      });
      const linkCount = Array.isArray(result?.links) ? result.links.length : 0;
      const message = result?.success
        ? linkCount > 0 ? `已发现 ${linkCount} 台 Crazyflie` : 'Crazyradio 已就绪，尚未发现飞行器'
        : result?.message;
      this.setResult(!!result?.success, message);
    } catch (error: any) {
      this.setResult(false, error?.message || '无线链路检测失败');
    }
    return this.state$.value;
  }
}
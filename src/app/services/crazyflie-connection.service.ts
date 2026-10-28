import { Injectable, NgZone, OnDestroy } from '@angular/core';
import { BehaviorSubject } from 'rxjs';
import { CrazyflieTelemetryService, CrazyflieTelemetryState } from './crazyflie-telemetry.service';
import { AttitudeEvent, AttitudeReception, AttitudeSample, isAttitudeSample } from './crazyflie-attitude';

export type CrazyflieConnectionStatus = 'unknown' | 'checking' | 'ready' | 'error' | 'disconnected';
export type CrazyflieDeckType = 'flow-v2' | 'multiranger' | 'led-ring' | 'buzzer';
export interface CrazyradioInterface { index: number; serial: string; }
export interface CrazyflieConnectionOptions { uri: string; addressHex: string; radioId?: string; }
export interface CrazyflieConnectionState {
  status: CrazyflieConnectionStatus;
  message: string;
  updatedAt: number | null;
  busy?: boolean;
  uri?: string;
  addressHex?: string;
  radioSerial?: string;
  radioIndex?: number;
}
interface ConnectionResult {
  success: boolean;
  message?: string;
  uri?: string;
  addressHex?: string;
  radios?: CrazyradioInterface[];
}
interface ConnectionApi {
  connect(options: CrazyflieConnectionOptions): Promise<ConnectionResult>;
  disconnect(): Promise<ConnectionResult>;
  listInterfaces(): Promise<ConnectionResult>;
  getConnectionState(): Promise<CrazyflieConnectionState>;
  onConnection(callback: (state: CrazyflieConnectionState) => void): () => void;
  onTelemetry(callback: (state: Partial<CrazyflieTelemetryState>) => void): () => void;
  onAttitude(callback: (event: AttitudeEvent) => void): () => void;
}
function connectionApi(): ConnectionApi | undefined {
  const api: unknown = window['crazyflie'];
  if (typeof api !== 'object' || api === null) return undefined;
  if ('connect' in api && typeof api.connect === 'function'
    && 'disconnect' in api && typeof api.disconnect === 'function'
    && 'listInterfaces' in api && typeof api.listInterfaces === 'function'
    && 'getConnectionState' in api && typeof api.getConnectionState === 'function'
    && 'onConnection' in api && typeof api.onConnection === 'function'
    && 'onTelemetry' in api && typeof api.onTelemetry === 'function'
    && 'onAttitude' in api && typeof api.onAttitude === 'function') return api as ConnectionApi;
  return undefined;
}

@Injectable({ providedIn: 'root' })
export class CrazyflieConnectionService implements OnDestroy {
  readonly detectedDecks$ = new BehaviorSubject<CrazyflieDeckType[]>([]);
  readonly attitude$ = new BehaviorSubject<AttitudeSample | null>(null);
  readonly attitudeError$ = new BehaviorSubject<string | null>(null);
  attitudeReception = new AttitudeReception();
  readonly state$ = new BehaviorSubject<CrazyflieConnectionState>({
    status: 'unknown', message: '尚未连接飞行器', updatedAt: null,
  });
  radios: CrazyradioInterface[] = [];
  selectedRadioSerial = '';
  private readonly dispose: Array<() => void> = [];
  private radioRefresh: Promise<void> | null = null;

  constructor(private telemetry: CrazyflieTelemetryService, private zone: NgZone) {
    const api = connectionApi();
    if (!api) return;
    this.dispose.push(api.onConnection(state => this.zone.run(() => this.receiveState(state))));
    this.dispose.push(api.onTelemetry(state => this.zone.run(() => {
      if (['ready', 'checking'].includes(this.state$.value.status)) this.telemetry.setTelemetry(state);
    })));
    this.dispose.push(api.onAttitude(event => this.zone.run(() => this.receiveAttitude(event))));
    const initial = this.state$.value;
    void api.getConnectionState().then(state => {
      if (this.state$.value === initial) this.zone.run(() => this.receiveState(state));
    }).catch(error => this.zone.run(() => this.setResult(false, String(error))));
  }

  ngOnDestroy(): void { this.dispose.forEach(dispose => dispose()); }

  private receiveAttitude(event: AttitudeEvent): void {
    if (!['ready', 'checking'].includes(this.state$.value.status)) return;
    if (event.type === 'sample') {
      if (!isAttitudeSample(event)) {
        this.attitudeError$.next('收到无效的真机姿态');
      } else if (this.attitudeReception.receive(event, performance.now())) {
        this.attitudeError$.next(null);
        this.attitude$.next(event);
      }
    } else if (event.type === 'error') {
      this.attitudeError$.next(event.message);
    } else if (event.type === 'stopped') {
      this.attitudeError$.next('真机姿态数据流已停止');
    }
  }

  private clearAttitude(): void {
    this.attitudeReception = new AttitudeReception();
    this.attitude$.next(null);
    this.attitudeError$.next(null);
  }

  get connectionOptions(): CrazyflieConnectionOptions {
    const state = this.state$.value;
    return {
      uri: state.status === 'ready' && state.uri ? state.uri
        : `radio://${this.selectedRadioSerial || '0'}/80/2M`,
      addressHex: state.status === 'ready' && state.addressHex ? state.addressHex : 'E7E7E7E7E7',
    };
  }

  private receiveState(state: CrazyflieConnectionState): void {
    if (!['unknown', 'checking', 'ready', 'error', 'disconnected'].includes(state.status)) {
      this.setResult(false, '收到无效的飞行器连接状态');
      return;
    }
    if (state.status !== 'ready') this.clearAttitude();
    const identity = state.radioSerial ? `无线收发器 ${state.radioIndex} · ${state.radioSerial}` : 'Crazyflie';
    const message = state.status === 'ready'
      ? `${identity} → ${state.uri}（${state.busy ? '执行中' : '已连接'}）`
      : state.message || (state.status === 'checking' ? '正在连接飞行器…' : '飞行器已断开');
    this.state$.next({ ...state, message, updatedAt: Date.now() });
    if (state.radioSerial) this.selectedRadioSerial = state.radioSerial;
    if (!['ready', 'checking'].includes(state.status)) {
      this.telemetry.clear();
      this.detectedDecks$.next([]);
    }
  }

  setChecking(): void {
    this.clearAttitude();
    this.state$.next({ ...this.state$.value, status: 'checking', message: '正在连接飞行器…', updatedAt: Date.now() });
  }

  setResult(success: boolean, message?: string): void {
    const current = this.state$.value;
    if (current.status === 'ready') return;
    this.clearAttitude();
    this.state$.next({ ...current, status: success ? 'unknown' : 'error',
      message: message || (success ? '无线收发器检测完成，尚未连接飞行器' : '飞行器连接失败'), updatedAt: Date.now() });
    this.telemetry.clear();
  }

  setDeckDetected(deck: CrazyflieDeckType, detected: boolean): void {
    const decks = new Set(this.detectedDecks$.value);
    if (detected) decks.add(deck);
    else decks.delete(deck);
    this.detectedDecks$.next(Array.from(decks));
  }

  refreshRadios(): Promise<void> {
    if (this.radioRefresh) return this.radioRefresh;
    const api = connectionApi();
    if (!api) return Promise.reject(new Error('未找到持久连接接口，请重启应用'));
    this.radioRefresh = api.listInterfaces().then(result => {
      if (!result.success || !Array.isArray(result.radios)) {
        throw new Error(result.message || '无法读取无线收发器列表');
      }
      const radios = result.radios;
      this.zone.run(() => {
        this.radios = radios;
        if (['ready', 'checking'].includes(this.state$.value.status)) return;
        if (!radios.some(radio => radio.serial === this.selectedRadioSerial)) this.selectedRadioSerial = '';
        if (!this.selectedRadioSerial && radios.length === 1) this.selectedRadioSerial = radios[0].serial;
      });
    }).finally(() => { this.radioRefresh = null; });
    return this.radioRefresh;
  }

  async connect(options: CrazyflieConnectionOptions): Promise<CrazyflieConnectionState> {
    const api = connectionApi();
    if (!api) throw new Error('未找到持久连接接口，请重启应用');
    if (this.state$.value.status === 'ready') return this.state$.value;
    await this.refreshRadios();
    if (!this.selectedRadioSerial) throw new Error(this.radios.length
      ? '检测到多个无线收发器，请先选择设备' : '未检测到 Crazyradio 无线收发器');
    this.setChecking();
    try {
      const result = await api.connect({ ...options, radioId: this.selectedRadioSerial });
      if (!result.success) throw new Error(result.message || '连接飞行器失败');
      return this.state$.value;
    } catch (error) {
      this.setResult(false, error instanceof Error ? error.message : String(error));
      throw error;
    }
  }

  async disconnect(): Promise<void> {
    const api = connectionApi();
    if (!api) throw new Error('未找到持久连接接口，请重启应用');
    const result = await api.disconnect();
    if (!result.success) throw new Error(result.message || '断开飞行器失败');
    this.receiveState({ status: 'disconnected', message: '飞行器已断开', updatedAt: Date.now() });
  }
}

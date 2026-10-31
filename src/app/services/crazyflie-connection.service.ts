import { Injectable, NgZone, OnDestroy } from '@angular/core';
import { BehaviorSubject, Subject } from 'rxjs';
import { CrazyflieTelemetryService, CrazyflieTelemetryState } from './crazyflie-telemetry.service';
import { AttitudeEvent, AttitudeReception, AttitudeSample, isAttitudeSample } from './crazyflie-attitude';
import { isMappingSample, MappingEvent } from './crazyflie-mapping';

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
export interface CrazyflieFlightReadiness {
  status: 'unknown' | 'ready' | 'needs-arming' | 'flying' | 'blocked';
  label: string;
  message: string;
}
interface ConnectionTelemetry extends Partial<CrazyflieTelemetryState> {
  flightReadiness?: unknown;
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
  onTelemetry(callback: (state: ConnectionTelemetry) => void): () => void;
  onAttitude(callback: (event: AttitudeEvent) => void): () => void;
  setMapping?(enabled: boolean): Promise<ConnectionResult>;
  onMapping?(callback: (event: unknown) => void): () => void;
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
  readonly mapping$ = new Subject<MappingEvent>();
  readonly flightReadiness$ = new BehaviorSubject<CrazyflieFlightReadiness>({
    status: 'unknown', label: '未确认', message: '尚未连接真机，无法确认固件是否允许起飞',
  });
  attitudeReception = new AttitudeReception();
  readonly state$ = new BehaviorSubject<CrazyflieConnectionState>({
    status: 'unknown', message: '尚未连接飞行器', updatedAt: null,
  });
  radios: CrazyradioInterface[] = [];
  selectedRadioSerial = '';
  private readonly dispose: Array<() => void> = [];
  private radioRefresh: Promise<void> | null = null;
  private readinessTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private telemetry: CrazyflieTelemetryService, private zone: NgZone) {
    const api = connectionApi();
    if (!api) return;
    this.dispose.push(api.onConnection(state => this.zone.run(() => this.receiveState(state))));
    this.dispose.push(api.onTelemetry(state => this.zone.run(() => {
      if (['ready', 'checking'].includes(this.state$.value.status)) {
        this.telemetry.setTelemetry(state);
        if ('flightReadiness' in state) this.receiveReadiness(state.flightReadiness);
      }
    })));
    this.dispose.push(api.onAttitude(event => this.zone.run(() => this.receiveAttitude(event))));
    if (api.onMapping) this.dispose.push(api.onMapping(event => this.zone.run(() => this.receiveMapping(event))));
    const initial = this.state$.value;
    void api.getConnectionState().then(state => {
      if (this.state$.value === initial) this.zone.run(() => this.receiveState(state));
    }).catch(error => this.zone.run(() => this.setResult(false, String(error))));
  }

  ngOnDestroy(): void {
    if (this.readinessTimer !== null) clearTimeout(this.readinessTimer);
    this.dispose.forEach(dispose => dispose());
    this.mapping$.complete();
  }

  private receiveMapping(value: unknown): void {
    if (!['ready', 'checking'].includes(this.state$.value.status)) return;
    if (isMappingSample(value)) {
      if (!this.detectedDecks$.value.includes('multiranger')) this.setDeckDetected('multiranger', true);
      this.mapping$.next(value);
    }
    else if (typeof value === 'object' && value !== null && 'type' in value) {
      if (value.type === 'stopped' || value.type === 'reference') this.mapping$.next({ type: value.type });
      else if (value.type === 'error' && 'message' in value && typeof value.message === 'string') {
        this.mapping$.next({ type: 'error', message: value.message });
      } else {
        console.warn('Invalid Crazyflie mapping event', value);
        this.mapping$.next({ type: 'error', message: '建图遥测无效，已暂停入图' });
      }
    } else {
      console.warn('Invalid Crazyflie mapping event', value);
      this.mapping$.next({ type: 'error', message: '建图遥测无效，已暂停入图' });
    }
  }

  async setMapping(enabled: boolean): Promise<void> {
    const api = connectionApi();
    if (!api?.setMapping) throw new Error('未找到测距建图接口，请重启应用');
    if (this.state$.value.status !== 'ready') throw new Error('请先连接真机；建图不会自动连接或控制电机');
    const result = await api.setMapping(enabled);
    if (!result.success) throw new Error(result.message || '测距建图采集切换失败');
  }

  private clearReadiness(message = '连接未就绪，无法确认固件是否允许起飞'): void {
    if (this.readinessTimer !== null) clearTimeout(this.readinessTimer);
    this.readinessTimer = null;
    this.flightReadiness$.next({ status: 'unknown', label: '未确认', message });
  }

  private receiveReadiness(payload: unknown): void {
    if (typeof payload === 'object' && payload !== null && 'source' in payload) {
      if (payload.source === 'unavailable') {
        this.clearReadiness('当前固件未提供可飞状态；无线已连接不代表允许起飞');
        return;
      }
      if ('value' in payload && typeof payload.value === 'number' && Number.isInteger(payload.value)
        && payload.value >= 0
        && ((payload.source === 'supervisor' && payload.value <= 0xffff)
          || (payload.source === 'legacy' && payload.value <= 1))) {
        const info = payload.value;
        const supervisor = payload.source === 'supervisor';
        let state: CrazyflieFlightReadiness;
        if (supervisor && (info & 0x0040)) {
          state = { status: 'blocked', label: '禁止起飞',
            message: '固件已锁定。确认电机已停、检查机体并放平，安全断电重启后重新连接；复位模型不能解锁真机' };
        } else if (supervisor && (info & 0x0020)) {
          state = { status: 'blocked', label: '禁止起飞',
            message: '固件检测到机体翻倒。确认电机已停，放平机体并等待固件恢复；不要盲目重复运行' };
        } else if (supervisor && (info & 0x0080)) {
          state = { status: 'blocked', label: '禁止起飞',
            message: '固件检测到碰撞。确认电机已停，检查机体并按固件要求恢复' };
        } else if (supervisor && (info & 0x0800)) {
          state = { status: 'blocked', label: '禁止起飞',
            message: '固件报告扩展板故障。确认电机已停，检查扩展板连接与定位配置' };
        } else if (supervisor && (info & 0x0010)) {
          state = { status: 'flying', label: '飞行中', message: '固件报告飞行中；请勿重复启动另一段起飞流程' };
        } else if (supervisor ? Boolean(info & 0x0008) : info === 1) {
          state = { status: 'ready', label: '允许起飞',
            message: '固件当前允许起飞；这不是安全保证，仍需确认姿态、定位、电量和周围环境' };
        } else if (supervisor && (info & 0x0001) && !(info & 0x0002)) {
          state = { status: 'needs-arming', label: '待解锁',
            message: '固件允许解锁，但尚未允许起飞。请先确认姿态、定位与电量；执行流程中的解锁结果以固件状态为准' };
        } else {
          state = { status: 'blocked', label: '禁止起飞',
            message: '固件尚未允许起飞。请检查机体姿态、定位与电量；当前信息不足以判断是否需要重启' };
        }
        if (this.readinessTimer !== null) clearTimeout(this.readinessTimer);
        this.flightReadiness$.next(state);
        this.readinessTimer = setTimeout(() => this.zone.run(() =>
          this.clearReadiness('固件可飞状态已过期，无法确认是否允许起飞')), 1500);
        return;
      }
    }
    const message = '收到无效的固件可飞状态，无法确认是否允许起飞';
    if (this.flightReadiness$.value.message !== message) console.warn(message);
    this.clearReadiness(message);
  }

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
    if (state.status !== 'ready') {
      if (this.state$.value.status === 'ready') this.mapping$.next({ type: 'reference' });
      this.clearAttitude();
      this.clearReadiness();
    }
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
    this.clearReadiness();
    this.state$.next({ ...this.state$.value, status: 'checking', message: '正在连接飞行器…', updatedAt: Date.now() });
  }

  setResult(success: boolean, message?: string): void {
    const current = this.state$.value;
    if (current.status === 'ready') return;
    this.clearAttitude();
    this.clearReadiness();
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

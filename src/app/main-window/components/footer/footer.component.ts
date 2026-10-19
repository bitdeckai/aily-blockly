import { Component, ChangeDetectorRef, OnDestroy } from '@angular/core';
import { CommonModule } from '@angular/common';
import { ActionState, UiService } from '../../../services/ui.service';
import { FOOTER_BTNS, IMenuItem } from '../../../configs/menu.config';
import { NzToolTipModule } from 'ng-zorro-antd/tooltip';
import { Subscription } from 'rxjs';
import { Router } from '@angular/router';
import { ProjectService } from '../../../services/project.service';
import { CrazyflieTelemetryService, CrazyflieTelemetryState } from '../../../services/crazyflie-telemetry.service';

@Component({
  selector: 'app-footer',
  imports: [CommonModule, NzToolTipModule],
  templateUrl: './footer.component.html',
  styleUrl: './footer.component.scss'
})
export class FooterComponent implements OnDestroy {
  actionData: ActionState | null;
  timer;
  telemetryState: CrazyflieTelemetryState | null = null;
  private telemetrySubscription?: Subscription;

  FOOTER_BTNS = FOOTER_BTNS;

  constructor(
    private uiService: UiService,
    private cd: ChangeDetectorRef,
    private telemetryService: CrazyflieTelemetryService,
    private projectService: ProjectService,
    private router: Router,
  ) {
    this.uiService.stateSubject.subscribe((state: ActionState) => {
      this.changeState(state);
    });
    // 其他窗口通过electron侧改变主窗口状态
    window['ipcRenderer'].on('state-update', (event, state: ActionState) => {
      this.changeState(state);
    });
    this.telemetrySubscription = this.telemetryService.telemetry$.subscribe((state) => {
      this.telemetryState = state;
      this.cd.markForCheck();
    });
  }

  ngOnDestroy(): void {
    this.telemetrySubscription?.unsubscribe();
  }

  get showCrazyflieTelemetry(): boolean {
    const boardName = String(this.projectService.currentBoardConfig?.name || '').toLowerCase();
    const inEditor = this.router.url.includes('/main/blockly-editor') || this.router.url.includes('/main/code-editor');
    return inEditor && boardName.includes('crazyflie');
  }

  get batteryPercent(): number | null {
    const value = this.telemetryState?.batteryPercent;
    return typeof value === 'number' && Number.isFinite(value)
      ? Math.max(0, Math.min(100, Math.round(value)))
      : null;
  }

  get linkQuality(): number | null {
    const value = this.telemetryState?.linkQuality;
    return typeof value === 'number' && Number.isFinite(value)
      ? Math.max(0, Math.min(100, Math.round(value)))
      : null;
  }

  get batteryVolts(): string {
    const value = this.telemetryState?.batteryVolts;
    return typeof value === 'number' && Number.isFinite(value) ? value.toFixed(3) : '--';
  }

  batteryLevelClass(): string {
    if ((this.batteryPercent ?? 0) <= 25) return 'level-danger';
    if ((this.batteryPercent ?? 0) <= 60) return 'level-warn';
    return 'level-good';
  }

  linkLevelClass(): string {
    if ((this.linkQuality ?? 0) <= 40) return 'level-danger';
    if ((this.linkQuality ?? 0) <= 70) return 'level-warn';
    return 'level-good';
  }

  changeState(e: ActionState) {
    this.actionData = e;
    this.cd.detectChanges();
    // 默认超时设置10秒, warn 和 error 不超时 
    if (!this.actionData.timeout && this.actionData.state === 'loading' || this.actionData.state === 'done') {
      this.actionData.timeout = 10000;
    }
    if (this.actionData.timeout) {
      clearTimeout(this.timer);
      this.timer = setTimeout(() => {
        this.actionData = null;
        this.cd.detectChanges();
      }, this.actionData.timeout);
    }
  }

  async process(item: IMenuItem) {
    switch (item.action) {
      case 'log-open':
        this.uiService.turnBottomSider('log');
        break;
      case 'terminal-open':
        this.uiService.turnBottomSider('terminal');
        break;
      default:
        console.log('未处理的操作:', item.action);
        break;
    }
  }

  isButtonActive(item: IMenuItem): boolean {
    switch (item.action) {
      case 'log-open':
        return this.uiService.terminalIsOpen && this.uiService.currentBottomTab === 'log';
      case 'terminal-open':
        return this.uiService.terminalIsOpen && this.uiService.currentBottomTab === 'terminal';
      default:
        return false;
    }
  }
}

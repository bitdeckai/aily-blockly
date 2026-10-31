import { AfterViewInit, Component, ElementRef, Input, OnChanges, OnDestroy, ViewChild } from '@angular/core';
import { TranslateModule } from '@ngx-translate/core';
import { MappingPose, RangeVoxelMap } from '../../../../../../services/crazyflie-mapping';

@Component({
  selector: 'app-crazyflie-occupancy-map',
  standalone: true,
  imports: [TranslateModule],
  template: `
    <canvas #canvas tabindex="0" role="img"
      [attr.aria-label]="'CRAZYFLIE_MAPPING.VIEW_2D' | translate"
      [title]="'CRAZYFLIE_MAPPING.PLANAR_HINT' | translate"
      (pointerdown)="beginPan($event)" (pointermove)="movePan($event)"
      (pointerup)="endPan($event)" (pointercancel)="endPan($event)"
      (contextmenu)="$event.preventDefault()" (wheel)="onWheel($event)" (keydown)="onKey($event)"></canvas>
  `,
  styles: [`
    :host { display: block; min-width: 0; min-height: 220px; height: 100%; }
    canvas { display: block; width: 100%; height: 100%; touch-action: none; cursor: grab; }
    canvas:active { cursor: grabbing; }
    canvas:focus-visible { outline: 2px solid #429bcc; outline-offset: -2px; }
  `],
})
export class CrazyflieOccupancyMapComponent implements AfterViewInit, OnChanges, OnDestroy {
  @Input({ required: true }) map!: RangeVoxelMap;
  @Input() revision = 0;
  @Input() pose: MappingPose | null = null;
  @Input() gridVisible = true;
  @ViewChild('canvas') canvas?: ElementRef<HTMLCanvasElement>;
  private observer: ResizeObserver | null = null;
  private automaticFit = true;
  private centre = { x: 0, z: 0 };
  private scale = 60;
  private drag: { id: number; x: number; y: number } | null = null;

  ngAfterViewInit(): void {
    this.observer = new ResizeObserver(() => this.draw());
    this.observer.observe(this.canvas!.nativeElement);
    this.draw();
  }

  ngOnChanges(): void { this.draw(); }
  ngOnDestroy(): void { this.observer?.disconnect(); }

  fit(): void {
    this.automaticFit = true;
    this.draw();
  }

  focusPose(): void {
    this.automaticFit = false;
    if (this.pose) this.centre = { x: this.pose.x, z: this.pose.z };
    this.draw();
  }

  zoom(factor: number): void {
    if (!Number.isFinite(factor) || factor <= 0) throw new Error('Invalid map zoom factor');
    this.automaticFit = false;
    this.scale = Math.max(2, Math.min(1600, this.scale / factor));
    this.draw();
  }

  capture(): string {
    if (!this.canvas) throw new Error('二维地图尚未就绪');
    return this.canvas.nativeElement.toDataURL('image/png');
  }

  beginPan(event: PointerEvent): void {
    if (event.button !== 0 && event.button !== 2) return;
    this.automaticFit = false;
    this.drag = { id: event.pointerId, x: event.clientX, y: event.clientY };
    this.canvas?.nativeElement.setPointerCapture(event.pointerId);
    event.preventDefault();
  }

  movePan(event: PointerEvent): void {
    if (!this.drag || this.drag.id !== event.pointerId) return;
    this.centre.x += (event.clientX - this.drag.x) / this.scale;
    this.centre.z += (event.clientY - this.drag.y) / this.scale;
    this.drag = { id: event.pointerId, x: event.clientX, y: event.clientY };
    this.draw();
  }

  endPan(event: PointerEvent): void {
    if (this.drag?.id !== event.pointerId) return;
    this.drag = null;
    if (this.canvas?.nativeElement.hasPointerCapture(event.pointerId)) {
      this.canvas.nativeElement.releasePointerCapture(event.pointerId);
    }
  }

  onWheel(event: WheelEvent): void {
    event.preventDefault();
    const canvas = this.canvas?.nativeElement;
    if (!canvas) return;
    const bounds = canvas.getBoundingClientRect();
    const x = event.clientX - bounds.left - bounds.width / 2;
    const y = event.clientY - bounds.top - bounds.height / 2;
    const worldX = this.centre.x - x / this.scale, worldZ = this.centre.z - y / this.scale;
    this.zoom(Math.exp(Math.max(-500, Math.min(500, event.deltaY)) * 0.0015));
    this.centre = { x: worldX + x / this.scale, z: worldZ + y / this.scale };
    this.draw();
  }

  onKey(event: KeyboardEvent): void {
    if (event.key === 'Home') this.fit();
    else if (event.key.toLowerCase() === 'f') this.focusPose();
    else if (event.key === '+' || event.key === '=') this.zoom(0.7);
    else if (event.key === '-') this.zoom(1.4);
    else if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) {
      this.automaticFit = false;
      this.centre.x += (event.key === 'ArrowRight' ? 24 : event.key === 'ArrowLeft' ? -24 : 0) / this.scale;
      this.centre.z += (event.key === 'ArrowDown' ? 24 : event.key === 'ArrowUp' ? -24 : 0) / this.scale;
      this.draw();
    } else return;
    event.preventDefault();
    event.stopPropagation();
  }

  private draw(): void {
    const canvas = this.canvas?.nativeElement;
    if (!canvas) return;
    const context = canvas.getContext('2d');
    if (!context) throw new Error('二维地图需要 Canvas 2D 支持');
    const width = Math.max(1, canvas.clientWidth), height = Math.max(1, canvas.clientHeight);
    const ratio = Math.min(window.devicePixelRatio || 1, 2);
    if (canvas.width !== Math.round(width * ratio)) canvas.width = Math.round(width * ratio);
    if (canvas.height !== Math.round(height * ratio)) canvas.height = Math.round(height * ratio);
    if (this.automaticFit) {
      let minX = Math.min(-2, this.pose?.x ?? 0), maxX = Math.max(2, this.pose?.x ?? 0);
      let minZ = Math.min(-2, this.pose?.z ?? 0), maxZ = Math.max(2, this.pose?.z ?? 0);
      for (const cell of this.map.cells.values()) {
        minX = Math.min(minX, cell.x); maxX = Math.max(maxX, cell.x);
        minZ = Math.min(minZ, cell.z); maxZ = Math.max(maxZ, cell.z);
      }
      this.centre = { x: (minX + maxX) / 2, z: (minZ + maxZ) / 2 };
      this.scale = Math.max(2, Math.min(800, (width - 40) / (maxX - minX), (height - 40) / (maxZ - minZ)));
    }
    context.setTransform(ratio, 0, 0, ratio, 0, 0);
    context.fillStyle = '#697579';
    context.fillRect(0, 0, width, height);
    const screen = (x: number, z: number) => ({
      x: width / 2 - (x - this.centre.x) * this.scale,
      y: height / 2 - (z - this.centre.z) * this.scale,
    });
    const size = this.map.resolution * this.scale;
    const drawCells = (occupied: boolean) => {
      context.fillStyle = occupied ? '#101214' : '#e8e8e3';
      for (const cell of this.map.cells.values()) {
        if (cell.occupied !== occupied) continue;
        const point = screen(cell.x, cell.z);
        context.fillRect(Math.floor(point.x - size / 2), Math.floor(point.y - size / 2),
          Math.ceil(size) + 1, Math.ceil(size) + 1);
      }
    };
    drawCells(false);
    if (this.gridVisible) {
      const step = this.scale * 0.1 >= 12 ? 0.1 : 1;
      const origin = screen(0, 0), spacing = step * this.scale;
      context.beginPath();
      for (let x = ((origin.x % spacing) + spacing) % spacing; x < width; x += spacing) {
        context.moveTo(x, 0); context.lineTo(x, height);
      }
      for (let y = ((origin.y % spacing) + spacing) % spacing; y < height; y += spacing) {
        context.moveTo(0, y); context.lineTo(width, y);
      }
      context.strokeStyle = '#8d999a';
      context.lineWidth = 0.5;
      context.stroke();
    }
    drawCells(true);
    const origin = screen(0, 0);
    context.font = '12px sans-serif';
    for (const [label, colour, dx, dy] of [['X', '#ff7373', 28, 0], ['Y', '#8ee2a3', 0, -28]] as const) {
      context.beginPath(); context.moveTo(origin.x, origin.y); context.lineTo(origin.x + dx, origin.y + dy);
      context.strokeStyle = colour; context.lineWidth = 2; context.stroke();
      context.fillStyle = colour; context.fillText(label, origin.x + dx + 4, origin.y + dy - 4);
    }
    if (this.pose) {
      const point = screen(this.pose.x, this.pose.z);
      context.save(); context.translate(point.x, point.y); context.rotate(-this.pose.yaw);
      context.beginPath(); context.moveTo(10, 0); context.lineTo(-7, -6); context.lineTo(-7, 6); context.closePath();
      context.fillStyle = '#1261cc'; context.fill();
      context.strokeStyle = '#fff'; context.lineWidth = 2; context.stroke(); context.restore();
      context.fillStyle = '#18252dcc';
      context.fillRect(6, 5, Math.min(240, width - 12), 22);
      context.fillStyle = '#fff';
      context.fillText(`X ${(-this.pose.x).toFixed(2)} m  Y ${this.pose.z.toFixed(2)} m`, 10, 20);
    }
    const length = this.scale >= 80 ? 0.1 : 1;
    const barX = width - 18 - length * this.scale, barY = height - 18;
    context.fillStyle = '#18252dcc';
    context.fillRect(barX - 6, barY - 24, length * this.scale + 12, 31);
    context.beginPath(); context.moveTo(barX, barY); context.lineTo(width - 18, barY);
    context.strokeStyle = '#fff'; context.lineWidth = 3; context.stroke();
    context.fillStyle = '#fff'; context.fillText(length === 0.1 ? '10 cm' : '1 m', barX, barY - 7);
  }
}

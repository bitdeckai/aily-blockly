import * as Blockly from 'blockly';

type PreviewMount = (field: FieldCameraPreview, element: HTMLElement) => () => void;
const previewMounts = new WeakMap<Blockly.Workspace, PreviewMount>();

export function bindCameraPreviewWorkspace(workspace: Blockly.Workspace, mount: PreviewMount): () => void {
  previewMounts.set(workspace, mount);
  return () => previewMounts.delete(workspace);
}

export class FieldCameraPreview extends Blockly.Field<number> {
  static readonly MIN_WIDTH = 240;
  static readonly MAX_WIDTH = 640;
  private foreignObject: SVGForeignObjectElement | null = null;
  private unmount: (() => void) | null = null;
  private height = 32;

  constructor(width = 320) {
    super(Blockly.Field.SKIP_SETUP);
    this.SERIALIZABLE = true;
    this.EDITABLE = false;
    this.setValue(width);
  }

  static override fromJson(options: Blockly.FieldConfig & { width?: number }): FieldCameraPreview {
    return new FieldCameraPreview(options.width);
  }

  protected override initView(): void {
    const block = this.getSourceBlock();
    const mount = block && !block.isInsertionMarker() ? previewMounts.get(block.workspace) : undefined;
    if (!mount || !this.fieldGroup_) return;
    this.foreignObject = Blockly.utils.dom.createSvgElement('foreignObject', {}, this.fieldGroup_);
    const element = document.createElement('div');
    element.className = 'camera-block-preview';
    // Controls must not start Blockly dragging, keyboard shortcuts, or workspace zoom.
    for (const type of ['pointerdown', 'mousedown', 'touchstart', 'keydown', 'wheel']) {
      element.addEventListener(type, event => event.stopPropagation());
    }
    this.foreignObject.appendChild(element);
    this.unmount = mount(this, element);
  }

  protected override doClassValidation_(value: unknown): number | null {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      console.warn('Camera preview: invalid saved width', value);
      return null;
    }
    return Math.round(Math.max(FieldCameraPreview.MIN_WIDTH, Math.min(FieldCameraPreview.MAX_WIDTH, value)));
  }

  override fromXml(element: Element): void {
    this.setValue(Number(element.textContent));
  }

  override saveState(): number | null { return this.getValue(); }

  override loadState(state: unknown): void { this.setValue(state); }

  protected override render_(): void {
    this.size_.width = this.foreignObject ? this.getValue()! : 1;
    this.size_.height = this.foreignObject ? this.height : 1;
    this.foreignObject?.setAttribute('width', String(this.size_.width));
    this.foreignObject?.setAttribute('height', String(this.size_.height));
  }

  setPreviewHeight(height: number): void {
    const next = Math.max(32, Math.ceil(height));
    if (next === this.height) return;
    this.height = next;
    this.forceRerender();
  }

  protected override getText_(): string { return ''; }

  override dispose(): void {
    this.unmount?.();
    this.unmount = null;
    this.foreignObject = null;
    super.dispose();
  }
}

Blockly.fieldRegistry.register('field_camera_preview', FieldCameraPreview);

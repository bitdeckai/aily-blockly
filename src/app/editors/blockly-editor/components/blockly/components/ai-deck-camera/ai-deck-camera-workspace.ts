import * as Blockly from 'blockly';
import { Subscription } from 'rxjs';
import type { ComponentRef } from '@angular/core';
import type { AiDeckCameraComponent } from './ai-deck-camera.component';
import type { AiDeckCameraService } from '../../../../../../services/ai-deck-camera.service';
import type { AiDeckCameraCommand } from '../../../../../../services/ai-deck-camera';
import { bindCameraPreviewWorkspace, FieldCameraPreview } from '../../custom-field/field-camera-preview';

export class AiDeckCameraWorkspace {
  private readonly previews = new Map<FieldCameraPreview, ComponentRef<AiDeckCameraComponent>>();
  private readonly unmounts = new Map<FieldCameraPreview, () => void>();
  private readonly subscriptions = new Subscription();
  private readonly unbind: () => void;
  private active: FieldCameraPreview | null = null;

  constructor(
    workspace: Blockly.WorkspaceSvg,
    private readonly camera: AiDeckCameraService,
    createView: (element: HTMLElement) => ComponentRef<AiDeckCameraComponent>,
    private readonly reportError: (key: string) => void,
  ) {
    this.unbind = bindCameraPreviewWorkspace(workspace, (field, element) => {
      const view = createView(element);
      const listeners = new Subscription();
      this.previews.set(field, view);
      const syncAddress = () => this.updateAddress(view,
        this.literalAddress(field)?.getFieldValue('TEXT') ?? camera.address$.value);
      syncAddress();
      view.setInput('previewWidth', field.getValue());
      view.setInput('gestureState', camera.gestureState$.value);
      listeners.add(view.instance.gestureControl.subscribe(action => {
        if (!camera.gestures) { this.reportError('CAMERA_GESTURE.RESTART_DESKTOP'); return; }
        if (action === 'authorize' || action === 'disarm') camera.gestures.authorize(action === 'authorize');
        else void camera.gestures[action]().catch(error => this.reportError(error instanceof Error ? error.message : String(error)));
      }));
      listeners.add(view.instance.connectRequested.subscribe(() => {
        if (this.literalAddress(field) || !view.instance.address.trim()) syncAddress();
      }));
      listeners.add(view.instance.opening.subscribe(() => {
        this.disconnectOthers(field);
        this.active = field;
        camera.frameSource = view.instance;
        camera.showPanel();
      }));
      listeners.add(view.instance.addressChange.subscribe(address => {
        const literal = this.literalAddress(field);
        if (literal && literal.getFieldValue('TEXT') !== address) literal.setFieldValue(address, 'TEXT');
        camera.address$.next(address);
      }));
      listeners.add(view.instance.closed.subscribe(() => camera.hidePanel()));
      listeners.add(view.instance.resized.subscribe(delta => {
        field.setValue(field.getValue()! + delta);
        view.setInput('previewWidth', field.getValue());
      }));
      listeners.add(view.instance.heightChange.subscribe(height => field.setPreviewHeight(height)));
      const onChange = (event: Blockly.Events.Abstract) => {
        if (event.type !== Blockly.Events.BLOCK_CHANGE && event.type !== Blockly.Events.BLOCK_MOVE) return;
        view.setInput('previewWidth', field.getValue());
        syncAddress();
      };
      workspace.addChangeListener(onChange);
      view.changeDetectorRef.detectChanges();
      const unmount = () => {
        if (!this.previews.has(field)) return;
        workspace.removeChangeListener(onChange);
        listeners.unsubscribe();
        this.previews.delete(field);
        this.unmounts.delete(field);
        if (this.active === field) {
          this.active = null;
          camera.frameSource = null;
          camera.hidePanel();
        }
        view.destroy();
      };
      this.unmounts.set(field, unmount);
      return unmount;
    });
    this.subscriptions.add(camera.address$.subscribe(address => {
      for (const [field, view] of this.previews) {
        if (!this.literalAddress(field)) this.updateAddress(view, address);
      }
    }));
    this.subscriptions.add(camera.gestureState$.subscribe(state => {
      for (const view of this.previews.values()) view.setInput('gestureState', state);
    }));
    this.subscriptions.add(camera.command$.subscribe(command => {
      if (!command) return;
      if (command.type !== 'open') {
        this.active = null;
        camera.frameSource = null;
        for (const view of this.previews.values()) this.send(view, command);
        return;
      }
      const field = camera.previewBlockId
        ? [...this.previews.keys()].find(candidate => candidate.getSourceBlock()?.id === camera.previewBlockId)
        : this.active || this.previews.keys().next().value;
      if (!field) {
        this.reportError('AI_DECK_CAMERA.PREVIEW_REQUIRED');
        return;
      }
      this.disconnectOthers(field);
      this.active = field;
      this.send(this.previews.get(field)!, command);
    }));
  }

  private literalAddress(field: FieldCameraPreview): Blockly.Block | null {
    let previous = field.getSourceBlock()?.getPreviousBlock();
    while (previous) {
      if (previous.type === 'cf_ai_deck_config') {
        const address = previous.getInputTargetBlock('ADDRESS');
        return address?.type === 'text' ? address : null;
      }
      previous = previous.getPreviousBlock();
    }
    return null;
  }

  private updateAddress(view: ComponentRef<AiDeckCameraComponent>, address: string): void {
    if (view.instance.address === address) return;
    if (view.instance.streamUrl) view.instance.closePreview();
    view.setInput('address', address);
  }

  private send(view: ComponentRef<AiDeckCameraComponent>, command: AiDeckCameraCommand): void {
    view.setInput('command', { ...command });
    view.changeDetectorRef.detectChanges();
  }

  private disconnectOthers(field: FieldCameraPreview): void {
    for (const [candidate, view] of this.previews) {
      if (candidate !== field) this.send(view, { type: 'close' });
    }
  }

  dispose(): void {
    this.subscriptions.unsubscribe();
    this.unbind();
    for (const unmount of this.unmounts.values()) unmount();
    this.active = null;
  }
}

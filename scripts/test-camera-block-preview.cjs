const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');
const ts = require('typescript');
const { Subject } = require('rxjs');
const root = path.resolve(__dirname, '..');
const directory = path.join(root, 'src', 'app', 'editors', 'blockly-editor', 'components', 'blockly');
const protocol = require('./helpers/load-crazyflie-data.cjs')(path.join(root, 'src', 'app', 'services', 'ai-deck-camera.ts'));

function harness() {
  const timers = new Map(), warnings = [], errors = [], changes = new Set(), views = [];
  let nextTimer = 0, mount;
  class Emitter extends Subject { emit(value) { this.next(value); } }
  class Input { constructor(checked, value = '') { this.checked = checked; this.value = value; } }
  const core = {
    Component: () => value => value, Injectable: () => value => value,
    Input: () => () => {}, Output: () => () => {}, ViewChild: () => () => {}, EventEmitter: Emitter,
    inject: () => ({ markForCheck() {} }),
  };
  function load(filename) {
    const exports = {};
    vm.runInNewContext(ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, experimentalDecorators: true },
    }).outputText, {
      exports, URL, HTMLInputElement: Input, console: { warn: (...args) => warnings.push(args) },
      setTimeout: callback => { timers.set(++nextTimer, callback); return nextTimer; },
      setInterval: callback => { timers.set(++nextTimer, callback); return nextTimer; },
      clearTimeout: id => timers.delete(id), clearInterval: id => timers.delete(id),
      require: name => {
        if (name === '@angular/core') return core;
        if (name === 'rxjs') return require(name);
        if (name === 'blockly') return { Events: { BLOCK_CHANGE: 'change', BLOCK_MOVE: 'move' } };
        if (name.endsWith('/ai-deck-camera')) return protocol;
        if (name.endsWith('/field-camera-preview')) return {
          bindCameraPreviewWorkspace(workspace, callback) {
            mount = callback;
            return () => { mount = null; };
          },
        };
        return {};
      },
    });
    return exports;
  }
  const { AiDeckCameraComponent } = load(path.join(directory, 'components', 'ai-deck-camera', 'ai-deck-camera.component.ts'));
  const { AiDeckCameraService } = load(path.join(root, 'src', 'app', 'services', 'ai-deck-camera.service.ts'));
  const { AiDeckCameraWorkspace } = load(path.join(directory, 'components', 'ai-deck-camera', 'ai-deck-camera-workspace.ts'));
  const service = new AiDeckCameraService();
  const workspace = {
    addChangeListener: callback => changes.add(callback),
    removeChangeListener: callback => changes.delete(callback),
  };
  const bridge = new AiDeckCameraWorkspace(workspace, service, () => {
    const instance = new AiDeckCameraComponent();
    let changedCommand = false;
    const view = {
      instance, destroyed: 0,
      setInput(name, value) { instance[name] = value; if (name === 'command') changedCommand = true; },
      changeDetectorRef: { detectChanges() {
        if (changedCommand) { changedCommand = false; instance.ngOnChanges({ command: {} }); }
      } },
      destroy() { this.destroyed++; instance.ngOnDestroy(); },
    };
    views.push(view);
    return view;
  }, key => errors.push(key));
  function add(id, previous = null) {
    const block = { id, previous, getPreviousBlock: () => block.previous };
    const field = {
      width: 320, height: 0,
      getSourceBlock: () => block,
      getValue() { return this.width; },
      setValue(value) { this.width = Math.max(240, Math.min(640, value)); },
      setPreviewHeight(height) { this.height = height; },
    };
    const unmount = mount(field, {});
    return { field, block, view: views.at(-1), camera: views.at(-1).instance, unmount };
  }
  return { bridge, service, add, timers, warnings, errors, views, changes, Input };
}

test('manual close immediately disarms recognition and disposing the active preview clears the frame source', () => {
  const h = harness(), active = h.add('active');
  let stops = 0;
  h.service.gestures = { start: async () => {}, stop: async () => { stops++; }, authorize() {} };
  active.camera.address = '192.168.4.1';
  active.camera.connect();
  assert.equal(h.service.frameSource, active.camera);
  h.service.gestureState$.next({ ...h.service.gestureState$.value, phase: 'running' });
  active.camera.closePreview();
  assert.equal(stops, 1);
  assert.equal(h.service.frameSource, null);
  active.camera.connect();
  h.bridge.dispose();
  assert.equal(h.service.frameSource, null);
  assert.equal(h.service.visible$.value, false);
});

test('a refused manual authorization cannot leave a misleading checked checkbox', () => {
  const h = harness(), active = h.add('active'), input = new h.Input(true);
  h.service.gestures = { start: async () => {}, stop: async () => {}, authorize() {} };
  active.camera.requestAuthorization({ target: input });
  assert.equal(input.checked, false);
  h.service.gestures.authorize = enabled => h.service.gestureState$.next({ ...h.service.gestureState$.value, authorized: enabled });
  input.checked = true;
  active.camera.requestAuthorization({ target: input });
  assert.equal(input.checked, true);
  h.bridge.dispose();
});
test('installing, copying, showing the category and resizing a preview never opens a stream', () => {
  const h = harness(), first = h.add('one'), second = h.add('two');
  h.service.showPanel();
  first.camera.resized.emit(80);
  assert.equal(first.field.width, 400);
  assert.equal(first.camera.previewWidth, 400);
  assert.equal(second.field.width, 320);
  first.camera.heightChange.emit(180);
  assert.equal(first.field.height, 180);
  first.field.width = 240;
  for (const change of h.changes) change({ type: 'change' });
  assert.equal(first.camera.previewWidth, 240, 'undo/redo updates the embedded controls');
  assert.equal(h.timers.size, 0);
  assert.equal(first.camera.streamUrl, '');
  assert.equal(second.camera.streamUrl, '');
  h.bridge.dispose();
});

test('manual opening reads a preceding literal configuration and only one block streams at a time', () => {
  const h = harness();
  const config = { type: 'cf_ai_deck_config', getInputTargetBlock: () =>
    ({ type: 'text', getFieldValue: () => '192.168.4.1' }) };
  const first = h.add('one', { type: 'cf_delay', getPreviousBlock: () => config });
  const second = h.add('two');
  first.camera.connect();
  assert.equal(first.camera.streamUrl, 'http://192.168.4.1/stream');
  assert.equal(h.timers.size, 2);
  second.camera.address = 'camera.local:8080';
  second.camera.connect();
  assert.equal(first.camera.streamUrl, '');
  assert.equal(second.camera.streamUrl, 'http://camera.local:8080/stream');
  assert.equal(h.timers.size, 2, 'old timers are released before opening another block');
  first.camera.resized.emit(80);
  assert.equal(second.camera.state, 'connecting');
  assert.equal(h.timers.size, 2, 'resize does not reconnect');
  second.camera.closed.emit();
  assert.equal(second.camera.streamUrl, '');
  assert.equal(h.timers.size, 0);
  h.bridge.dispose();
});

test('preview addresses follow their own literal configuration on mount, text edits, moves and reconnect', () => {
  const h = harness();
  const literal = value => {
    const text = { type: 'text', value, getFieldValue: () => text.value,
      setFieldValue: value => { text.value = value; } };
    return { type: 'cf_ai_deck_config', text, getInputTargetBlock: () => text };
  };
  h.service.address$.next('192.168.3');
  const config = literal('192.168.3.156'), otherConfig = literal('192.168.4.2');
  const first = h.add('one', config), second = h.add('two', otherConfig);
  assert.equal(first.camera.address, '192.168.3.156', 'a stale session address cannot override the project');
  assert.equal(second.camera.address, '192.168.4.2');
  config.text.value = '192.168.3.157';
  for (const change of h.changes) change({ type: 'change' });
  assert.equal(first.camera.address, '192.168.3.157');
  assert.equal(second.camera.address, '192.168.4.2');
  first.camera.changeAddress({ target: new h.Input(false, '192.168.3.158') });
  assert.equal(config.text.value, '192.168.3.158', 'manual editing updates the saved configuration too');
  assert.equal(second.camera.address, '192.168.4.2', 'another configuration must not be overwritten');
  first.camera.connect();
  config.text.value = '192.168.3.159';
  for (const change of h.changes) change({ type: 'change' });
  assert.equal(first.camera.streamUrl, '', 'changing an active target closes it without reconnecting');
  assert.equal(first.camera.address, '192.168.3.159');
  first.block.previous = otherConfig;
  for (const change of h.changes) change({ type: 'move' });
  assert.equal(first.camera.address, '192.168.4.2');
  first.camera.address = '192.168.3';
  first.camera.connect();
  assert.equal(first.camera.streamUrl, 'http://192.168.4.2/stream');
  h.bridge.dispose();
});

test('a nearest variable configuration is never replaced by an older literal, and runtime values stay authoritative', () => {
  const h = harness();
  const older = { type: 'cf_ai_deck_config', getInputTargetBlock: () =>
    ({ type: 'text', getFieldValue: () => '192.168.4.99' }) };
  const variable = { type: 'cf_ai_deck_config', getInputTargetBlock: () => ({ type: 'variables_get' }),
    getPreviousBlock: () => older };
  const preview = h.add('dynamic', variable);
  h.service.execute({ type: 'configure', address: '192.168.4.5' });
  h.service.previewBlockId = 'dynamic';
  h.service.execute({ type: 'open' });
  assert.equal(preview.camera.address, '192.168.4.5');
  assert.equal(preview.camera.streamUrl, 'http://192.168.4.5/stream');
  assert.equal(h.errors.length, 0);
  h.bridge.dispose();
});

test('program commands use the actual execution block, repeat requests and close all previews', () => {
  const h = harness(), first = h.add('one'), second = h.add('two');
  h.service.execute({ type: 'configure', address: '192.168.4.1' });
  h.service.previewBlockId = 'two';
  h.service.execute({ type: 'open' });
  assert.equal(first.camera.streamUrl, '');
  assert.equal(second.camera.streamUrl, 'http://192.168.4.1/stream');
  h.service.previewBlockId = 'one';
  h.service.execute({ type: 'open' });
  assert.equal(second.camera.streamUrl, '');
  assert.equal(first.camera.state, 'connecting');
  const command = { type: 'open' };
  h.service.execute(command);
  h.service.execute(command);
  assert.equal(first.camera.state, 'connecting');
  assert.equal(h.timers.size, 2, 'even the same command object is reapplied without leaking timers');
  h.service.execute({ type: 'close' });
  assert.equal(first.camera.streamUrl, '');
  assert.equal(second.camera.streamUrl, '');
  assert.equal(h.timers.size, 0);
  h.bridge.dispose();
});

test('deleting a live block and disposing the editor abort streams and remove every listener', () => {
  const h = harness(), first = h.add('one'), second = h.add('two');
  h.service.execute({ type: 'configure', address: '192.168.4.1' });
  first.camera.connect();
  first.unmount();
  first.unmount();
  assert.equal(first.view.destroyed, 1);
  assert.equal(h.timers.size, 0);
  second.camera.connect();
  h.bridge.dispose();
  assert.equal(h.timers.size, 0);
  assert.equal(h.changes.size, 0);
  assert.equal(second.view.destroyed, 1);
  second.unmount();
  assert.equal(second.view.destroyed, 1);
  h.service.execute({ type: 'open' });
  assert.equal(h.timers.size, 0);
});

test('a program with no preview block surfaces a visible error instead of opening an invisible connection', () => {
  const h = harness();
  h.service.execute({ type: 'configure', address: '192.168.4.1' });
  h.service.execute({ type: 'open' });
  assert.deepEqual(h.errors, ['AI_DECK_CAMERA.PREVIEW_REQUIRED']);
  assert.equal(h.timers.size, 0);
  const other = h.add('different-block');
  h.service.previewBlockId = 'deleted-block';
  h.service.execute({ type: 'open' });
  assert.equal(other.camera.streamUrl, '', 'a missing execution block must not silently open a different preview');
  assert.equal(h.errors.length, 2);
  h.bridge.dispose();
});

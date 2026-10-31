const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');
const ts = require('typescript');
const THREE = require('three');

test('compact attitude inset and the left telemetry HUD reserve the same responsive width', () => {
  const filename = path.join(__dirname, '..', 'src', 'app', 'editors', 'blockly-editor',
    'components', 'blockly', 'components', 'crazyflie-sim-panel', 'crazyflie-sim-panel.component.scss');
  const css = require('sass').compile(filename).css;
  assert.match(css, /\.sim-panel__canvas-wrap\s*\{[^}]*--sim-attitude-inset-width: clamp\(96px, 20%, 120px\)/);
  assert.match(css, /\.sim-attitude-inset\s*\{[^}]*width: var\(--sim-attitude-inset-width\)/);
  assert.match(css, /\.sim-attitude-inset__viewport\s*\{[^}]*aspect-ratio: 1\.3/);
  assert.match(css, /\.sim-hud\s*\{[^}]*max-width: calc\(100% - var\(--sim-attitude-inset-width\) - 26px\)/);
  assert.match(css, /\.sim-hud__attitude\s*\{[^}]*flex-wrap: wrap;[^}]*flex-basis: 100%/);
  assert.match(css, /\.sim-hud__attitude > span\s*\{[^}]*white-space: nowrap/);
});

test('model and view reset controls wrap together with independent spacing', () => {
  const filename = path.join(__dirname, '..', 'src', 'app', 'editors', 'blockly-editor',
    'components', 'blockly', 'components', 'crazyflie-sim-panel', 'crazyflie-sim-panel.component.scss');
  const css = require('sass').compile(filename).css;
  assert.match(css, /(?:^|\n)\.sim-quick-reset-actions \{\s*display: inline-flex;\s*gap: 6px;\s*\}/);
});

const blocklyDirectory = path.join(__dirname, '..', 'src', 'app', 'editors', 'blockly-editor', 'components', 'blockly');
function loadMethods(filename, names, context = {}, observeLayout = false) {
  const source = ts.createSourceFile(filename, fs.readFileSync(filename, 'utf8'), ts.ScriptTarget.Latest, true);
  const component = source.statements.find(node => ts.isClassDeclaration(node)
    && names.every(name => node.members.some(member => member.name?.getText(source) === name)));
  assert.ok(component, 'production component must contain the selected methods');
  let methods = names.map(name => {
    const method = component.members.find(member => member.name?.getText(source) === name);
    assert.ok(method, `missing production method ${name}`);
    return method.getText(source);
  }).join('\n');
  if (observeLayout) {
    let observer;
    function visit(node) {
      if (ts.isNewExpression(node) && node.expression.getText(source) === 'ResizeObserver'
        && node.getText(source).includes('this.clampToolboxWidth')) observer = node;
      ts.forEachChild(node, visit);
    }
    visit(component);
    assert.ok(observer, 'layout must respond to its actual ResizeObserver');
    methods += `\nobserveLayout() { this.resizeObserver = ${observer.getText(source)}; }`;
  }
  const { outputText } = ts.transpileModule(`class Harness { ${methods} }`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  });
  return vm.runInNewContext(`${outputText}\nHarness`, { ...THREE, ...context });
}

function layoutHarness(available = 1920) {
  const grid = new Map(), pane = new Map();
  const frames = [];
  let resize;
  const Component = loadMethods(path.join(blocklyDirectory, 'blockly.component.ts'), [
    'layoutColumns', 'clampToolboxWidth', 'queueToolboxWidth', 'flushToolboxWidth',
    'cancelToolboxResizeAnimationFrame', 'applyQueuedToolboxWidth', 'applyToolboxWidth',
  ], {
    requestAnimationFrame: callback => { frames.push(callback); return frames.length; },
    cancelAnimationFrame() {},
    ResizeObserver: class {
      constructor(callback) { resize = callback; }
    },
  }, true);
  const layout = Object.assign(new Component(), {
    toolboxWidth: 185, preferredToolboxWidth: 185, pendingToolboxWidth: 185,
    toolboxMinWidth: 160, toolboxMaxWidth: 420, toolboxResizeAnimationFrame: null,
    showSimPanel: true, uiService: { blocklyToolboxWidth: 185 },
    layoutElementRef: { nativeElement: { clientWidth: available, style: { setProperty: (...args) => grid.set(...args) } } },
    toolboxPaneRef: { nativeElement: { style: { setProperty: (...args) => pane.set(...args) } } },
    cdr: { markForCheck() {} },
    resizeWorkspace() {}, scheduleWorkspaceResize() {},
  });
  layout.observeLayout();
  return { layout, grid, pane, frames, resize: () => resize() };
}

test('toolbox resizing retains all grid columns and keeps the header aligned', () => {
  for (const showSimPanel of [true, false]) {
    const { layout, grid, pane } = layoutHarness();
    layout.showSimPanel = showSimPanel;
    layout.flushToolboxWidth(420);
    assert.equal(grid.get('grid-template-columns'), layout.layoutColumns);
    assert.equal(grid.get('grid-template-columns').includes('minmax(320px, 42%)'), showSimPanel);
    assert.equal(pane.get('width'), '420px');
    assert.equal(layout.uiService.blocklyToolboxWidth, 420);
  }
});

test('camera-only right pane retains the same columns and width budget when the 3D panel is hidden', () => {
  const { layout, grid } = layoutHarness(1280);
  layout.showSimPanel = false;
  layout.showCameraPanel = true;
  layout.flushToolboxWidth(420);
  assert.ok(layout.layoutColumns.includes('minmax(320px, 42%)'));
  assert.equal(grid.get('grid-template-columns'), layout.layoutColumns);
  assert.ok(layout.toolboxWidth <= 1280 - 1280 * .42 - 240);
});

test('toolbox yields space on narrow viewports without losing the preferred width', () => {
  const { layout, pane, resize } = layoutHarness();
  layout.flushToolboxWidth(420);
  for (const available of [1920, 1366, 1024, 960, 800, 720, 640, 400, 1920]) {
    layout.layoutElementRef.nativeElement.clientWidth = available;
    resize();
    const expected = Math.min(420, Math.max(160, Math.floor(available - Math.max(320, available * 0.42) - 240)));
    assert.equal(layout.toolboxWidth, expected);
    assert.equal(layout.uiService.blocklyToolboxWidth, expected);
    assert.equal(pane.get('width'), `${expected}px`);
    assert.equal(layout.preferredToolboxWidth, 420);
    if (available >= 720) {
      assert.ok(available - expected - Math.max(320, available * 0.42) >= 240);
    }
  }
  assert.equal(layout.toolboxWidth, 420, 'returning to the larger display restores the preference');
  layout.isToolboxResizing = true;
  layout.layoutElementRef.nativeElement.clientWidth = 800;
  resize();
  assert.equal(layout.toolboxWidth, 420, 'the observer must not fight an active toolbox drag');
});

test('toolbox drag frames are coalesced and invalid widths leave the layout unchanged', () => {
  const { layout, frames } = layoutHarness(800);
  for (const width of [250, 300, 420]) layout.queueToolboxWidth(width);
  assert.equal(frames.length, 1);
  frames[0]();
  assert.equal(layout.toolboxWidth, 224);
  assert.equal(layout.preferredToolboxWidth, 420);
  for (const width of [undefined, NaN, Infinity, '300']) layout.queueToolboxWidth(width);
  assert.equal(layout.toolboxWidth, 224);
  assert.equal(frames.length, 1);
});

function rendererHarness() {
  const frames = [], ratios = [], sizes = [];
  const environment = { devicePixelRatio: 1 };
  let resizeCallback;
  const Component = loadMethods(path.join(blocklyDirectory, 'components', 'crazyflie-sim-panel',
    'crazyflie-sim-panel.component.ts'), ['resizeRenderer', 'observeResize', 'startRenderLoop'], {
    window: environment, performance: { now: () => 16 },
    requestAnimationFrame: callback => { frames.push(callback); return frames.length; },
    ResizeObserver: class {
      constructor(callback) { resizeCallback = callback; }
      observe() {}
    },
  });
  let ratio = 1;
  const panel = Object.assign(new Component(), {
    canvasHostRef: { nativeElement: { clientWidth: 640, clientHeight: 360 } },
    attitudeViewportRef: { nativeElement: {} },
    renderer: {
      getPixelRatio: () => ratio,
      setPixelRatio: value => { ratio = value; ratios.push(value); },
      setSize: (width, height) => sizes.push({ width, height, ratio }),
      render() {},
    },
    camera: new THREE.PerspectiveCamera(), scene: new THREE.Scene(), droneGroup: new THREE.Group(),
    targetPosition: new THREE.Vector3(), attitudeActive: true, lastAttitudeMetricsTs: 0,
    attitudeViewport: { x: 450, y: 8, width: 160, height: 100 },
    updateAttitudeViewport() { this.viewportUpdates = (this.viewportUpdates || 0) + 1; },
    controls: { target: new THREE.Vector3(1, 2, 3), update() {} },
    updatePropellerAnimation() {},
  });
  return { panel, environment, frames, ratios, sizes, resize: () => resizeCallback() };
}

test('DPI-only changes refresh the next render frame, cap at 2x, and preserve the camera', () => {
  const { panel, environment, frames, ratios, sizes } = rendererHarness();
  panel.camera.position.set(6, 4, -3);
  panel.camera.zoom = 1.7;
  const position = panel.camera.position.clone(), target = panel.controls.target.clone();
  panel.startRenderLoop();
  for (const ratio of [1, 1.25, 1.5, 2, 3, 2, 1.5, 1]) {
    environment.devicePixelRatio = ratio;
    frames.at(-1)();
    const count = sizes.length;
    frames.at(-1)();
    assert.equal(sizes.length, count, 'stable frames must not resize/reallocate the drawing buffer');
    assert.equal(panel.renderer.getPixelRatio(), Math.min(ratio, 2));
    assert.ok(panel.camera.position.equals(position));
    assert.ok(panel.controls.target.equals(target));
    assert.equal(panel.camera.zoom, 1.7);
  }
  assert.deepEqual(ratios, [1.25, 1.5, 2, 1.5, 1]);
  assert.equal(panel.viewportUpdates, ratios.length, 'the shared attitude inset must be refreshed too');
});

test('ResizeObserver refreshes scene aspect and DPI together, including short viewports', () => {
  const { panel, environment, sizes, resize } = rendererHarness();
  panel.observeResize();
  for (const [width, height, ratio] of [[320, 220, 1.25], [800, 450, 2], [480, 100, 1]]) {
    Object.assign(panel.canvasHostRef.nativeElement, { clientWidth: width, clientHeight: height });
    environment.devicePixelRatio = ratio;
    resize();
    assert.deepEqual(sizes.at(-1), { width, height: Math.max(220, height), ratio });
    assert.equal(panel.camera.aspect, width / Math.max(220, height));
  }
  const count = sizes.length;
  panel.renderer = null;
  resize();
  assert.equal(sizes.length, count, 'destroyed renderers must not be accessed');
});

test('short panels preserve the scrollable toolbar and usable footer instead of collapsing their content', () => {
  const styles = fs.readFileSync(path.join(blocklyDirectory, 'components', 'crazyflie-sim-panel',
    'crazyflie-sim-panel.component.scss'), 'utf8');
  assert.match(styles, /\.sim-panel\s*\{[^}]*overflow-y:\s*auto/);
  assert.match(styles, /\.sim-panel__controls\s*\{[^}]*min-height:\s*min-content/);
  assert.match(styles, /\.sim-panel__footer\s*\{[^}]*min-height:\s*48px/);
  assert.match(styles, /&:has\(\.sim-mission\)\s*\{[^}]*min-height:\s*96px/);
  assert.match(fs.readFileSync(path.join(blocklyDirectory, 'blockly.component.scss'), 'utf8'),
    /\.blockly-layout\s*\{[^}]*overflow-x:\s*auto/);
});

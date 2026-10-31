const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');
const ts = require('typescript');
const load = require('./helpers/load-crazyflie-data.cjs');
const root = path.resolve(__dirname, '..');
const { RangeVoxelMap } = load(path.join(root, 'src', 'app', 'services', 'crazyflie-mapping.ts'));

function harness() {
  const exports = {}, rectangles = [], rotations = [];
  let observed = null, disconnected = false, captured = null;
  const context = {
    fillRect(...bounds) { rectangles.push({ colour: this.fillStyle, bounds }); },
    setTransform() {}, beginPath() {}, moveTo() {}, lineTo() {}, stroke() {},
    fillText() {}, save() {}, restore() {}, translate() {}, closePath() {}, fill() {},
    rotate(value) { rotations.push(value); },
  };
  const canvas = {
    clientWidth: 400, clientHeight: 300, width: 0, height: 0,
    getContext: type => { assert.equal(type, '2d'); return context; },
    getBoundingClientRect: () => ({ left: 10, top: 20, width: 400, height: 300 }),
    setPointerCapture: id => captured = id,
    hasPointerCapture: id => captured === id,
    releasePointerCapture: () => captured = null,
    toDataURL: type => { assert.equal(type, 'image/png'); return 'data:image/png;base64,test'; },
  };
  const filename = path.join(root, 'src', 'app', 'editors', 'blockly-editor', 'components', 'blockly',
    'components', 'crazyflie-occupancy-map', 'crazyflie-occupancy-map.component.ts');
  vm.runInNewContext(ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, experimentalDecorators: true },
  }).outputText, {
    exports, window: { devicePixelRatio: 3 },
    ResizeObserver: class {
      observe(element) { observed = element; }
      disconnect() { disconnected = true; }
    },
    require: name => name === '@angular/core' ? {
      Component: () => value => value, Input: () => () => {}, ViewChild: () => () => {},
    } : {},
  });
  const view = new exports.CrazyflieOccupancyMapComponent();
  const map = new RangeVoxelMap();
  map.start('simulation', { x: 0, y: 0, z: 0, yaw: 0 });
  const sample = (timestampMs = 100) => ({
    type: 'sample', timestampMs, poseTimestampMs: timestampMs, epoch: 0,
    x: 0, y: 0, z: 0, roll: 0, pitch: 0, yaw: 0,
    ranges: { front: 1, back: null, left: null, right: null, up: null },
  });
  map.receive(sample());
  view.map = map;
  view.pose = map.pose;
  view.canvas = { nativeElement: canvas };
  view.ngAfterViewInit();
  return { view, map, canvas, sample, rectangles, rotations,
    get observed() { return observed; }, get disconnected() { return disconnected; },
    get captured() { return captured; } };
}

test('2D draws grey unknown, light observed rays and black walls last with bounded DPI and a heading marker', () => {
  const h = harness();
  assert.equal(h.observed, h.canvas);
  assert.equal(h.canvas.width, 800);
  assert.equal(h.canvas.height, 600);
  assert.equal(h.rectangles[0].colour, '#697579');
  const cells = h.rectangles.filter(rectangle => ['#e8e8e3', '#101214'].includes(rectangle.colour));
  assert.equal(cells.length, 11);
  assert.equal(cells.filter(cell => cell.colour === '#e8e8e3').length, 10);
  assert.equal(cells.at(-1).colour, '#101214');
  h.view.pose = { x: -0.5, y: 0.4, z: 0.2, yaw: Math.PI / 2 };
  h.view.ngOnChanges();
  assert.equal(h.rotations.at(-1), -Math.PI / 2);
  assert.equal(h.view.capture(), 'data:image/png;base64,test');
  h.view.ngOnDestroy();
  assert.equal(h.disconnected, true);
});

test('2D zoom anchors the pointer, drag pans and later frames preserve manual framing until fit', () => {
  const h = harness(), view = h.view;
  const point = { x: 250 - 10 - 200, y: 210 - 20 - 150 };
  const world = { x: view.centre.x - point.x / view.scale, z: view.centre.z - point.y / view.scale };
  const scale = view.scale;
  view.onWheel({ deltaY: -120, clientX: 250, clientY: 210, preventDefault() {} });
  assert.ok(view.scale > scale);
  assert.ok(Math.abs(view.centre.x - point.x / view.scale - world.x) < 1e-10);
  assert.ok(Math.abs(view.centre.z - point.y / view.scale - world.z) < 1e-10);
  view.beginPan({ button: 0, pointerId: 1, clientX: 0, clientY: 0, preventDefault() {} });
  assert.equal(h.captured, 1);
  const x = view.centre.x;
  view.movePan({ pointerId: 1, clientX: 20, clientY: 10 });
  assert.ok(view.centre.x > x);
  view.endPan({ pointerId: 1 });
  assert.equal(h.captured, null);
  const framing = JSON.stringify({ centre: view.centre, scale: view.scale });
  h.map.receive(h.sample(200));
  view.ngOnChanges();
  assert.equal(JSON.stringify({ centre: view.centre, scale: view.scale }), framing);
  view.fit();
  assert.equal(view.automaticFit, true);
  h.rectangles.length = 0;
  h.map.clear();
  view.ngOnChanges();
  assert.ok(!h.rectangles.some(rectangle => ['#e8e8e3', '#101214'].includes(rectangle.colour)));
  view.ngOnDestroy();
});

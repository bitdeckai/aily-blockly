const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const vm = require('node:vm');
const { test } = require('node:test');
const load = require('./helpers/load-crazyflie-data.cjs');
const root = path.resolve(__dirname, '..');
const { RangeVoxelMap, isMappingSample, firmwareTimeDifference } =
  load(path.join(root, 'src', 'app', 'services', 'crazyflie-mapping.ts'));
const { MappingCloud, simulateMappingSample, createMappingDemo } =
  load(path.join(root, 'src', 'app', 'services', 'crazyflie-mapping-scene.ts'));
const anchor = { x: 0, y: 0, z: 0, yaw: 0 };
const sample = (overrides = {}) => ({
  type: 'sample', timestampMs: 100, poseTimestampMs: 100, epoch: 0,
  x: 0, y: 0, z: 0, roll: 0, pitch: 0, yaw: 0,
  ranges: { front: 1, back: null, left: null, right: null, up: null }, ...overrides,
});
const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-6, `${a} != ${b}`);

test('2D rays mark only observed free cells and a black endpoint, leaving unobserved space unknown', () => {
  const map = new RangeVoxelMap();
  map.start('simulation', anchor);
  map.receive(sample());
  assert.equal(map.cells.size, 11);
  for (let x = 0; x > -10; x--) assert.equal(map.cells.get(`${x},0`).occupied, false);
  assert.equal(map.cells.get('-10,0').occupied, true);
  assert.equal(map.cells.has('-11,0'), false);
  assert.equal(map.cells.has('0,1'), false);
  assert.equal(map.cells.get('0,0').observations, 1);
  const empty = new RangeVoxelMap();
  empty.start('simulation', anchor);
  empty.receive(sample({ ranges: { front: null, back: null, left: null, right: null, up: null } }));
  assert.equal(empty.cells.size, 0, 'null/out-of-range rays must not invent free space');
  const diagonal = new RangeVoxelMap();
  diagonal.start('simulation', anchor);
  diagonal.receive(sample({ yaw: 45, ranges: { ...sample().ranges, front: Math.SQRT2 } }));
  assert.equal(diagonal.cells.size, 11);
  for (let i = 0; i <= 10; i++) assert.ok(diagonal.cells.has(`${-i},${i}`));
});

test('2D uses only near-horizontal side beams; height, heading and repeated rays keep measured walls fixed', () => {
  for (const [pitch, up, expected] of [[90, null, 0], [10.1, null, 0], [9.9, null, 11], [0, 1, 0]]) {
    const map = new RangeVoxelMap();
    map.start('simulation', anchor);
    map.receive(sample({ pitch, ranges: { ...sample().ranges, front: up === 1 ? null : 1, up } }));
    assert.equal(map.cells.size, expected);
    assert.ok(map.voxels.size > 0, '3D must keep the original tilted/upward observations');
  }
  const map = new RangeVoxelMap();
  map.start('hardware', { ...anchor, y: 0.3 });
  map.receive(sample({ x: 10, y: 20, z: 3 }));
  map.receive(sample({ timestampMs: 200, poseTimestampMs: 200, x: 10, y: 20, z: 3.5, yaw: 90,
    ranges: { ...sample().ranges, front: null, right: 1 } }));
  assert.equal(map.cells.size, 11);
  assert.equal(map.cells.get('-10,0').observations, 2);
  assert.equal(map.cells.get('-10,0').occupied, true);
  assert.equal(map.voxels.size, 2, 'height remains available in the retained 3D cloud');
  map.receive(sample({ timestampMs: 300, poseTimestampMs: 300, x: 10, y: 20, z: 3,
    ranges: { ...sample().ranges, front: 2 } }));
  assert.equal(map.cells.get('-10,0').occupied, true, 'new free rays must not erase a previously observed wall');
  assert.equal(map.cells.get('-20,0').occupied, true);
});

test('2D limits and resets are atomic with the 3D cloud and export explicit sparse occupancy semantics', () => {
  const map = new RangeVoxelMap();
  map.start('simulation', anchor);
  for (let i = 0; i < map.maximumCells; i++) {
    map.cells.set(`existing-${i}`, { x: 0, z: 0, occupied: false, observations: 1 });
  }
  assert.throws(() => map.receive(sample()), /20000/);
  assert.equal(map.active, false);
  assert.equal(map.samples, 0);
  assert.equal(map.voxels.size, 0);
  assert.equal(map.cells.size, 20000);
  map.clear();
  assert.equal(map.cells.size, 0);
  map.start('simulation', anchor);
  map.receive(sample());
  const data = JSON.parse(JSON.stringify(map.exportData())).occupancy;
  assert.equal(data.resolutionM, 0.1);
  assert.equal(data.occupiedValue, 100);
  assert.equal(data.freeValue, 0);
  assert.equal(data.unknownValue, -1);
  assert.equal(data.cells.length, 11);
  assert.deepEqual(data.cells.find(cell => cell.value === 100), { x: 1, y: 0, value: 100, observations: 1 });
  assert.match(data.unknownCells, /unknown, not free/);
  map.invalidate();
  assert.throws(() => map.start('simulation', anchor), /清空/);
  assert.equal(map.cells.size, 11);
});

test('mapping validates all five ranges, packet skew, timestamps and finite pose without inventing maximum-range hits', () => {
  assert.equal(isMappingSample(sample()), true);
  for (const bad of [sample({ ranges: {} }), sample({ epoch: -1 }), sample({ x: NaN }),
    sample({ poseTimestampMs: 49 }), sample({ timestampMs: 0x1000000 }),
    ...[0, 4, Infinity, '1', false].map(front => sample({ ranges: { ...sample().ranges, front } }))]) {
    assert.equal(isMappingSample(bad), false);
  }
  assert.equal(isMappingSample(sample({ timestampMs: 5, poseTimestampMs: 0xfffff5 })), true);
  near(firmwareTimeDifference(5, 0xfffff5), 16);
});

test('hardware position and five beam directions share one yaw-aligned reference, including legacy pitch and roll', () => {
  const map = new RangeVoxelMap();
  map.start('hardware', anchor);
  map.receive(sample({ x: 10, y: 20, z: 3, yaw: 90 }));
  near(map.pose.x, 0);
  near(Array.from(map.voxels.values())[0].x, -1);
  map.receive(sample({ timestampMs: 200, poseTimestampMs: 200, x: 10, y: 21, z: 3, yaw: 90 }));
  near(map.pose.x, -1);
  assert.ok(Array.from(map.voxels.values()).some(point => point.x === -2));
  const pitched = new RangeVoxelMap();
  pitched.start('simulation', anchor);
  pitched.receive(sample({ pitch: 90 }));
  near(Array.from(pitched.voxels.values())[0].y, 1);
  const rolled = new RangeVoxelMap();
  rolled.start('simulation', anchor);
  rolled.receive(sample({ roll: 90, ranges: { ...sample().ranges, front: null, up: 1 } }));
  near(Array.from(rolled.voxels.values())[0].z, -1);
});

test('in-flight hardware translation, rotation and height changes accumulate fixed world obstacles rather than rotating the old map', () => {
  const map = new RangeVoxelMap();
  map.start('hardware', { ...anchor, y: 0.3 });
  const ranges = { front: null, back: null, left: null, right: null, up: null };
  map.receive(sample({ x: 10, y: 20, z: 3, ranges }));
  for (const [index, yaw, direction, z] of [[1, 0, 'front', 3], [2, 90, 'right', 3],
    [3, 180, 'back', 3], [4, 0, 'front', 3.2]]) {
    const time = 100 + index * 200;
    map.receive(sample({ timestampMs: time, poseTimestampMs: time, x: 10.5, y: 20, z, yaw,
      ranges: { ...ranges, [direction]: 1.46 } }));
  }
  assert.equal(map.active, true);
  assert.equal(map.samples, 5);
  assert.equal(map.voxels.size, 2);
  const points = Array.from(map.voxels.values());
  assert.ok(points.every(point => Math.abs(point.x + 2) < 1e-6 && point.z === 0));
  assert.ok(points.some(point => Math.abs(point.y - 0.3) < 1e-6 && point.hits === 3));
  assert.ok(points.some(point => Math.abs(point.y - 0.5) < 1e-6));
});

test('pause, clear, duplicate/out-of-order frames, wrap and epoch reset preserve source and map integrity', () => {
  const map = new RangeVoxelMap();
  map.start('hardware', anchor);
  const first = sample({ timestampMs: 0xfffff0, poseTimestampMs: 0xfffff0 });
  assert.equal(map.receive(first), true);
  assert.equal(map.receive(first), false);
  assert.equal(map.receive(sample({ timestampMs: 10, poseTimestampMs: 10 })), true);
  assert.equal(map.receive(sample({ timestampMs: 5, poseTimestampMs: 5 })), false);
  assert.equal(map.samples, 2);
  assert.equal(map.voxels.size, 1);
  assert.equal(Array.from(map.voxels.values())[0].hits, 2);
  map.pause();
  assert.equal(map.receive(sample({ timestampMs: 20, poseTimestampMs: 20 })), false);
  assert.throws(() => map.start('simulation', anchor), /清空/);
  map.start('hardware', anchor);
  assert.throws(() => map.receive(sample({ timestampMs: 30, poseTimestampMs: 30, epoch: 1 })), /重置/);
  assert.equal(map.active, false);
  assert.equal(map.invalidated, true);
  assert.equal(map.voxels.size, 1);
  assert.throws(() => map.start('hardware', anchor), /清空/);
  map.clear();
  map.start('simulation', anchor);
  assert.equal(map.samples, 0);
  assert.equal(map.voxels.size, 0);
});

test('voxel and extent limits pause explicitly without partially inserting or evicting earlier points', () => {
  const map = new RangeVoxelMap();
  map.start('simulation', anchor);
  for (let i = 0; i < map.maximumVoxels; i++) map.voxels.set(`existing-${i}`, { x: 0, y: 0, z: 0, hits: 1 });
  assert.throws(() => map.receive(sample()), /20000/);
  assert.equal(map.active, false);
  assert.equal(map.voxels.size, map.maximumVoxels);
  map.clear();
  map.start('simulation', anchor);
  assert.throws(() => map.receive(sample({ x: 100 })), /50 m/);
  assert.equal(map.voxels.size, 0);
});

test('simulation raycasts explicit test obstacles rather than the coordinate grid and creates a bounded room outline', () => {
  const map = new RangeVoxelMap();
  map.start('simulation', anchor);
  const first = simulateMappingSample(anchor, 100);
  near(first.ranges.front, 1.96);
  near(first.ranges.up, 1.96);
  for (let i = 0; i < 180; i++) {
    map.receive(simulateMappingSample({ ...anchor, y: 0.3, yaw: i * Math.PI / 90 }, 100 + i * 200));
  }
  assert.ok(map.voxels.size > 100, `need an actual outline, received ${map.voxels.size} voxels`);
  assert.ok(map.cells.size > 1000, `need observed free area, received ${map.cells.size} cells`);
  assert.ok(Array.from(map.cells.values()).filter(cell => cell.occupied).length > 100);
  assert.ok(Array.from(map.voxels.values()).every(point =>
    Math.abs(point.x) <= 2 && Math.abs(point.z) <= 2 && point.y >= 0.2 && point.y <= 2));
  assert.throws(() => simulateMappingSample({ ...anchor, x: -0.9, y: 0.3, z: 0.75 }, 0), /障碍物/);
  const demo = createMappingDemo();
  assert.equal(demo.children.length, 6);
  demo.traverse(object => { object.geometry?.dispose(); object.material?.dispose(); });
});

test('rendering uses bounded reusable buffers, source colors and complete disposal; JSON uses flight coordinates and explicit provenance', () => {
  const map = new RangeVoxelMap();
  map.start('simulation', anchor);
  map.receive(sample({ x: 1, y: 2, z: 3 }));
  const cloud = new MappingCloud(map.maximumVoxels);
  cloud.update(map);
  const points = cloud.root.children[0];
  assert.equal(points.geometry.attributes.position.count, 20000);
  assert.equal(points.geometry.drawRange.count, 1);
  const buffer = points.geometry.attributes.position;
  assert.equal(points.material.color.getHexString(), '45d6b0');
  const data = JSON.parse(JSON.stringify(map.exportData()));
  assert.equal(data.format, 'robotstem-range-voxel-map');
  assert.equal(data.source, 'simulation');
  assert.equal(data.voxelSizeM, 0.1);
  assert.deepEqual(data.voxels[0], { x: 2, y: 2, z: 3, hits: 1 });
  assert.match(data.limitations.join('\n'), /not SLAM/);
  map.clear();
  cloud.update(map);
  assert.equal(points.geometry.drawRange.count, 0);
  assert.equal(points.geometry.attributes.position, buffer);
  let disposed = 0;
  points.geometry.addEventListener('dispose', () => disposed++);
  points.material.addEventListener('dispose', () => disposed++);
  cloud.dispose();
  assert.equal(disposed, 2);
});

test('mapping controls and limitations are localized for every Settings language', () => {
  const languages = JSON.parse(fs.readFileSync(path.join(root, 'public', 'i18n', 'i18n.json'), 'utf8'));
  const reference = JSON.parse(fs.readFileSync(path.join(root, 'public', 'i18n', 'en', 'en.json'), 'utf8')).CRAZYFLIE_MAPPING;
  for (const { code } of languages) {
    const labels = JSON.parse(fs.readFileSync(path.join(root, 'public', 'i18n', code, `${code}.json`), 'utf8')).CRAZYFLIE_MAPPING;
    for (const key of Object.keys(reference)) assert.ok(typeof labels?.[key] === 'string' && labels[key].trim(), `${code}: ${key}`);
    assert.match(labels.NOTICE, /SLAM/);
  }
  const css = require('sass').compile(path.join(root, 'src', 'app', 'editors', 'blockly-editor', 'components',
    'blockly', 'components', 'crazyflie-sim-panel', 'crazyflie-sim-panel.component.scss')).css;
  assert.match(css, /(?:^|\n)\.sim-mapping\s*\{[^}]*max-height: 180px;[^}]*overflow: auto/);
  assert.doesNotMatch(css, /\.sim-mapping\s*\{[^}]*position: absolute/);
  assert.match(css, /\.sim-mapping\s*\{[^}]*color: var\(--aily-text-primary/);
  assert.doesNotMatch(css, /\.sim-scene-select\s+\.sim-mapping/);
  const html = fs.readFileSync(path.join(root, 'src', 'app', 'editors', 'blockly-editor', 'components',
    'blockly', 'components', 'crazyflie-sim-panel', 'crazyflie-sim-panel.component.html'), 'utf8');
  assert.ok(html.indexOf('<section class="sim-mapping"') < html.indexOf('<div #canvasHost'));
  assert.match(html, /<details>\s*<summary>/);
  assert.doesNotMatch(html, /app-ai-deck-camera|复位模型/);
  assert.equal((html.match(/\(click\)="resetDronePose\(\)"/g) || []).length, 1);
  assert.match(html, /\(click\)="resetDronePose\(\)">复位<\/button>\s*<button[^>]*\(click\)="mappingExpanded = !mappingExpanded"/);
  const mainHtml = fs.readFileSync(path.join(root, 'src', 'app', 'editors', 'blockly-editor',
    'components', 'blockly', 'blockly.component.html'), 'utf8');
  assert.match(mainHtml, /@if \(showSimPanel\)/);
  assert.doesNotMatch(mainHtml, /showCameraPanel|app-ai-deck-camera/);
  assert.match(html, /<app-crazyflie-occupancy-map[^>]*\*ngIf="mapping2dShown"/);
  assert.match(html, /\[class\.sim-view-hidden\]="mapping2dShown"/);
  assert.match(html, /mappingView = '2d'/);
  assert.match(html, /mappingView = '3d'/);
});

test('desktop mapping handler requires the owning connected window and dispatches no connect, motor or flight operation', async () => {
  const code = fs.readFileSync(path.join(root, 'electron', 'crazyflie.js'), 'utf8');
  const snippet = code.match(/ipcMain\.handle\("crazyflie-mapping-control"[\s\S]*?\n  \}\);/)[0];
  const calls = [];
  let handler;
  const context = {
    owner: null,
    failure: error => ({ success: false, message: error.message }),
    ipcMain: { handle: (name, callback) => { assert.equal(name, 'crazyflie-mapping-control'); handler = callback; } },
  };
  vm.runInNewContext(snippet, context);
  const event = { sender: { id: 1 } };
  assert.equal((await handler(event, { enabled: true })).success, false);
  context.owner = { sender: { id: 2 }, status: 'ready' };
  assert.equal((await handler(event, { enabled: true })).success, false);
  context.owner = { sender: { id: 1 }, status: 'checking' };
  assert.equal((await handler(event, { enabled: true })).success, false);
  context.owner.status = 'ready';
  context.owner.worker = { running: true, request: async (action, options) => {
    calls.push({ action, enabled: options.enabled }); return { success: true };
  } };
  assert.equal((await handler(event, { enabled: 'true' })).success, false);
  assert.equal((await handler(event, { enabled: true })).success, true);
  assert.equal((await handler(event, { enabled: false })).success, true);
  assert.deepEqual(calls, [{ action: 'mapping', enabled: true }, { action: 'mapping', enabled: false }]);
  assert.equal(context.owner.worker.running, true);
});

test('Python mapping keeps two legal read-only packets synchronized, handles invalid ranges/wrap/reset, and cleans every fault', () => {
  const python = process.platform === 'win32' ? 'py' : 'python3';
  const args = process.platform === 'win32' ? ['-3'] : [];
  const result = spawnSync(python, [...args, '-B', '-c', `
import sys, types, queue, time
from pathlib import Path
from threading import Event
sys.path.insert(0, str(Path('child') / 'scripts'))
from crazyflie_mapping import stream_mapping, mapping_control
class Callback:
    def __init__(self): self.callbacks = []
    def add_callback(self, cb): self.callbacks.append(cb)
    def remove_callback(self, cb): self.callbacks.remove(cb)
    def call(self, *args):
        for cb in list(self.callbacks): cb(*args)
class Params:
    def __init__(self): self.reference = Callback()
    def get_value(self, name):
        assert name == 'deck.bcMultiranger'
        return '0' if mode == 'deck' else '1'
    def add_update_callback(self, group, name, cb):
        assert (group, name) == ('kalman', 'resetEstimation')
        self.reference.add_callback(cb)
    def remove_update_callback(self, group, name, cb): self.reference.remove_callback(cb)
class Config:
    def __init__(self, name, period_in_ms):
        assert period_in_ms == 200
        self.name, self.variables = name, []
        self.data_received_cb, self.error_cb = Callback(), Callback()
        self.stopped = self.deleted = False
        configs.append(self)
    def add_variable(self, name, kind): self.variables.append((name, kind))
    def stop(self): self.stopped = True
    def delete(self): self.deleted = True
    def start(self):
        if mode == 'start': raise RuntimeError('start failed')
        if self.name == 'AilyMappingPose':
            data = dict(zip([n for n, _ in self.variables], [10, 20, 3, 0, 0, 90]))
            if mode == 'pose': data['stateEstimate.x'] = float('nan')
            self.data_received_cb.call(0xfffff0, data, self)
        else:
            data = dict(zip([n for n, _ in self.variables], [500, 4000, 0, 65535, 1200]))
            if mode == 'range': data['range.front'] = True
            timestamp = 1000 if mode == 'skew' else -1 if mode == 'time' else 0xfffff5
            self.data_received_cb.call(timestamp, data, self)
            if mode == 'error': self.error_cb.call(self, 'log failed')
            if mode == 'disconnect': disconnected.call('mock')
            if mode == 'normal':
                self.data_received_cb.call(timestamp, data, self)
                self.data_received_cb.call(100, data, self)
                pose = configs[0]
                pose_data = dict(zip([n for n, _ in pose.variables], [10, 21, 3, 0, 0, 90]))
                pose.data_received_cb.call(100, pose_data, pose)
                params.reference.call('kalman.resetEstimation', '0')
                self.data_received_cb.call(200, data, self)
                pose.data_received_cb.call(210, pose_data, pose)
                self.data_received_cb.call(195, data, self)
                stopped.set()
def setup(next_mode):
    global mode, configs, messages, params, disconnected, stopped, scf
    mode, configs, messages = next_mode, [], []
    params, disconnected, stopped = Params(), Callback(), Event()
    scf = types.SimpleNamespace(cf=types.SimpleNamespace(param=params, disconnected=disconnected,
        log=types.SimpleNamespace(add_config=lambda cfg: None, toc=types.SimpleNamespace(
            get_element_by_complete_name=lambda name: None if mode == 'toc' else object()))))
setup('normal')
stream_mapping(scf, Config, stopped, messages.append)
samples = [item for item in messages if item['type'] == 'sample']
assert len(samples) == 3, messages
assert samples[0]['ranges'] == {'front': 0.5, 'back': None, 'left': None, 'right': None, 'up': 1.2}
assert samples[1]['poseTimestampMs'] == 100
assert samples[2]['epoch'] == 1 and samples[2]['poseTimestampMs'] == 210
assert [item['type'] for item in messages] == ['sample', 'sample', 'reference', 'sample']
for config in configs:
    size = sum(4 if kind == 'float' else 2 for _, kind in config.variables)
    assert size in (24, 10) and size <= 26
for fault in ('deck', 'toc', 'start', 'pose', 'range', 'time', 'skew', 'error', 'disconnect'):
    setup(fault)
    try: stream_mapping(scf, Config, stopped, messages.append, stale_sec=0.01)
    except (RuntimeError, TimeoutError): pass
    else: raise AssertionError(fault)
    for config in configs:
        if fault not in ('deck', 'toc'):
            assert config.stopped and config.deleted, fault
        assert not config.data_received_cb.callbacks and not config.error_cb.callbacks, fault
    assert not params.reference.callbacks and not disconnected.callbacks, fault
setup('continuous')
requests, shutdown = queue.Queue(), Event()
events = []
def wait_for(predicate):
    deadline = time.monotonic() + 3
    while not predicate():
        if time.monotonic() > deadline: raise AssertionError(events)
        time.sleep(0.005)
with mapping_control(scf, Config, events.append, requests, shutdown):
    requests.put({'id': 1, 'enabled': True})
    wait_for(lambda: any(e.get('id') == 1 for e in events))
    assert next(e for e in events if e.get('id') == 1)['result']['success']
    requests.put({'id': 2, 'enabled': False})
    wait_for(lambda: any(e.get('id') == 2 for e in events))
    assert next(e for e in events if e.get('id') == 2)['result']['success']
    params.reference.call('kalman.resetEstimation', '0')
    assert any(e.get('payload', {}).get('type') == 'reference' for e in events), 'reset while paused must be retained'
    requests.put({'id': 3, 'enabled': True})
    wait_for(lambda: any(e.get('id') == 3 for e in events))
    last_sample = [e['payload'] for e in events if e.get('payload', {}).get('type') == 'sample'][-1]
    assert last_sample['epoch'] == 1
assert not params.reference.callbacks and not disconnected.callbacks
assert all(c.stopped and c.deleted for c in configs)
print('read-only mapping pairing, faults, pause/resume and epoch cleanup passed')
`], { cwd: root, encoding: 'utf8', timeout: 15000 });
  assert.equal(result.status, 0, result.stderr || result.error?.message);
});

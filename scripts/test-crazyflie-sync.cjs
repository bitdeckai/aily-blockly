const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { spawnSync } = require('node:child_process');
const { test } = require('node:test');
const ts = require('typescript');

const root = path.resolve(__dirname, '..');
const services = path.join(root, 'src', 'app', 'services');
const generators = path.join(root, 'src', 'app', 'editors', 'blockly-editor', 'components',
  'blockly', 'generators', 'crazyflie');
const bridgeWindow = {};
const cache = new Map();
function load(filename) {
  if (cache.has(filename)) return cache.get(filename);
  const exports = {};
  const code = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022,
      experimentalDecorators: true },
  }).outputText;
  vm.runInNewContext(code, {
    exports, window: bridgeWindow, document: { getElementsByTagName: () => [] },
    performance, setTimeout, clearTimeout, console,
    require: name => {
      if (name === '@angular/core') return {
        Injectable: () => type => type, Component: () => type => type,
        HostListener: () => () => {}, ViewChild: () => () => {},
        ChangeDetectionStrategy: { OnPush: 0 },
      };
      if (['three', 'rxjs', 'blockly', 'blockly/blocks', 'blockly/python'].includes(name)) return require(name);
      if (name.endsWith('/crazyflie-attitude')) return load(path.join(services, 'crazyflie-attitude.ts'));
      if (name.endsWith('/crazyflie-classroom')) return load(path.join(services, 'crazyflie-classroom.ts'));
      if (name.endsWith('/motion-blocks')) return load(path.join(generators, 'motion-blocks.ts'));
      if (name.endsWith('/radio-blocks')) return load(path.join(generators, 'radio-blocks.ts'));
      if (name.endsWith('/basic-blocks')) return load(path.join(generators, 'basic-blocks.ts'));
      return {};
    },
  });
  cache.set(filename, exports);
  return exports;
}
const attitude = load(path.join(services, 'crazyflie-attitude.ts'));
const { CrazyflieSimService } = load(path.join(services, 'crazyflie-sim.service.ts'));
const { CrazyflieRuntimeService } = load(path.join(services, 'crazyflie-runtime.service.ts'));
const { _UploaderService } = load(path.join(root, 'src', 'app', 'editors', 'blockly-editor',
  'services', 'uploader.service.ts'));
const motion = load(path.join(generators, 'motion-blocks.ts'));
const sample = (timestampMs, extra = {}) => ({
  type: 'sample', timestampMs, roll: 2, pitch: -3, yaw: 0, x: 0, y: 0, z: 0, ...extra,
});
const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-6, `${a} != ${b}`);
const plain = value => JSON.parse(JSON.stringify(value));
const simulator = () => new CrazyflieSimService({ setDeckDetected() {} });

test('exactly three modes cycle without a sequential simulation gate', () => {
  const runtime = new CrazyflieRuntimeService();
  assert.equal(runtime.policy$.value, 'sim-only');
  assert.equal(runtime.cyclePolicy(), 'sim-real');
  assert.equal(runtime.cyclePolicy(), 'real-only');
  assert.equal(runtime.cyclePolicy(), 'sim-only');
  const header = fs.readFileSync(path.join(root, 'src', 'app', 'main-window', 'components',
    'header', 'header.component.html'), 'utf8');
  assert.equal((header.match(/setCrazyflieRuntimeMode\('/g) || []).length, 3);
  assert.doesNotMatch(header, /sim-first|仿真通过后实飞/);
});

test('firmware XYZ maps to the same body frame as simulated motion at nonzero initial headings', () => {
  const origin = { x: 0, y: 0.76573, z: 0, yaw: 0 };
  const reference = sample(0, { x: 8, y: 9, z: 2, yaw: 90 });
  const pose = attitude.relativeFlightPose(
    sample(50, { x: 7.7, y: 9.5, z: 2.2, yaw: 180 }), reference, origin);
  near(pose.x, -0.5);
  near(pose.z, 0.3);
  near(pose.y, origin.y + 0.2);
  near(pose.yaw, Math.PI / 2);
  const turnedOrigin = { ...origin, yaw: Math.PI / 2 };
  const turned = attitude.relativeFlightPose(sample(50, { x: 1 }), sample(0), turnedOrigin);
  near(turned.x, 0);
  near(turned.z, 1);
  near(attitude.relativeFlightPose(sample(50, { yaw: -179 }), sample(0, { yaw: 179 }), origin).yaw,
    Math.PI / 90);
  assert.equal(attitude.isFlightPoseSample(sample(0)), true);
  for (const invalid of [{ x: NaN }, { y: null }, { z: Infinity }, { yaw: '1' }]) {
    assert.equal(attitude.isFlightPoseSample(sample(1, invalid)), false);
  }
});

test('real-follow lifecycle aligns the first frame, rebases estimator resets, holds the last sample and guards reset/scene/run', async () => {
  const sim = simulator();
  const origin = { ...sim.pose$.value };
  sim.beginRealFollow();
  assert.equal(sim.running$.value, true);
  assert.equal(sim.poseSource$.value, 'real');
  assert.throws(() => sim.resetPose(), /复位/);
  assert.throws(() => sim.setRoomPreset('home'), /切换/);
  assert.equal((await sim.runCode('cf_print("blocked")')).success, false);
  sim.receiveRealPose(sample(0, { x: 20, y: 30, z: 2 }), 0);
  assert.deepEqual(plain(sim.pose$.value), origin);
  sim.receiveRealPose(sample(50, { x: 20.5, y: 30.3, z: 2.2 }), 50);
  near(sim.pose$.value.x, -0.5);
  near(sim.pose$.value.z, 0.3);
  near(sim.pose$.value.y, origin.y + 0.2);
  const beforeReset = { ...sim.pose$.value };
  sim.resetRealReference();
  sim.receiveRealPose(sample(100), 100);
  assert.deepEqual(plain(sim.pose$.value), beforeReset);
  sim.receiveRealPose(sample(150, { x: 0.1 }), 150);
  near(sim.pose$.value.x, -0.6);
  assert.throws(() => sim.receiveRealPose({ ...sample(200), x: 'bad' }, 200), /XYZ/);
  assert.equal(sim.realReception.metrics(651).stale, true);
  const last = plain(sim.pose$.value);
  sim.endRealFollow('done');
  sim.receiveRealPose(sample(250, { x: 100 }), 250);
  assert.deepEqual(plain(sim.pose$.value), last);
  assert.equal(sim.running$.value, false);
  assert.equal(sim.followingReal$.value, false);
  sim.resetPose();
  assert.equal(sim.poseSource$.value, 'simulation');
  assert.equal(sim.realAttitude$.value, null);
  assert.deepEqual(plain(sim.pose$.value), origin);
});

test('legacy/new project toolbox merges in either load order and hides only redundant flyout entries', () => {
  const legacy = JSON.parse(fs.readFileSync(path.join(root, 'child', 'boards', 'board-crazyflie',
    'template', 'node_modules', '@aily-project', 'lib-crazyflie-motion', 'toolbox.json'), 'utf8'));
  const builtIn = motion.createCrazyflieMotionToolbox(false);
  const collect = item => [item.type, ...(item.contents || []).flatMap(collect)].filter(Boolean);
  for (const [incoming, existing] of [[legacy, builtIn], [builtIn, legacy]]) {
    const merged = motion.mergeCrazyflieFlightToolbox(incoming, existing);
    assert.equal(merged.name, 'Crazyflie');
    assert.equal(merged.categoryId, 'crazyflie-motion');
    assert.equal(merged.colour, '#4a87c6');
    assert.deepEqual(plain(merged.contents.slice(0, 4).map(item => item.type)), [
      'cf_crazyflie_link', 'cf_test_crazyflie_link', 'cf_takeoff', 'cf_land',
    ]);
    const types = collect(merged);
    for (const type of ['cf_delay', 'cf_print_text', 'cf_print', 'cf_test_link', 'cf_link_config']) {
      assert.ok(!types.includes(type));
    }
    for (const type of ['cf_crazyflie_link', 'cf_takeoff', 'cf_land', 'cf_takeoff_at',
      'cf_move_at_speed', 'cf_detect_multiranger', 'cf_detect_led_ring']) assert.ok(types.includes(type), type);
    const topTypes = merged.contents.filter(item => item.type).map(item => item.type);
    assert.equal(new Set(topTypes).size, topTypes.length);
    const repeated = motion.mergeCrazyflieFlightToolbox(legacy, merged);
    assert.equal(collect(repeated).length, types.length);
  }
  const definitions = JSON.parse(fs.readFileSync(path.join(root, 'child', 'boards', 'board-crazyflie',
    'template', 'node_modules', '@aily-project', 'lib-crazyflie-motion', 'block.json'), 'utf8'));
  for (const type of ['cf_delay', 'cf_print_text', 'cf_print']) {
    assert.ok(definitions.some(block => block.type === type), `retain saved block ${type}`);
  }
});

test('compact scene UI has only classroom/home, no removed controls, and one camera reset', () => {
  const panelPath = path.join(root, 'src', 'app', 'editors', 'blockly-editor', 'components',
    'blockly', 'components', 'crazyflie-sim-panel');
  const html = fs.readFileSync(path.join(panelPath, 'crazyflie-sim-panel.component.html'), 'utf8');
  assert.doesNotMatch(html, /导入平面图|导入3D模型|清除贴图|清除3D模型|togglePause|stepOnce|onSpeedChanged|setExplosionAmount|type="file"/);
  assert.equal((html.match(/click\)="resetCameraView\(\)"/g) || []).length, 1);
  const select = /<select class="sim-scene-select"[\s\S]+?<\/select>/.exec(html)[0];
  assert.deepEqual([...select.matchAll(/<option value="([^"]+)"/g)].map(match => match[1]), ['classroom', 'home']);
  assert.match(select, /\[disabled\]="running"/);
});

function toolboxLoader() {
  const Blockly = require('blockly');
  const { BlocklyService } = load(path.join(root, 'src', 'app', 'editors', 'blockly-editor',
    'services', 'blockly.service.ts'));
  for (const spec of motion.motionBlocks) delete Blockly.Blocks[spec.type];
  const loader = Object.create(BlocklyService.prototype);
  Object.defineProperty(loader, 'workspace', { value: null, writable: true });
  let updates = 0;
  Object.assign(loader, {
    crazyflieBlockLanguage: 'zh', toolbox: { contents: [] },
    findToolboxItemIndex: () => -1, ensureToolboxItemIds() {}, applyToolboxSortOrderToContents() {},
    rebuildToolboxFacade() {}, syncToolboxFacadeWithWorkspace() {},
    workspace: {
      render() {},
      updateToolbox(toolbox) {
        updates++;
        const ws = new Blockly.Workspace();
        try {
          for (const block of toolbox.contents.filter(motion.isCrazyflieFlightToolbox)
            .flatMap(category => category.contents)
            .filter(item => motion.motionBlocks.some(spec => spec.type === item.type))) {
            Blockly.serialization.workspaces.load({
              blocks: { languageVersion: 0, blocks: [{ type: block.type, inputs: block.inputs }] },
            }, ws);
          }
        } finally { ws.dispose(); }
      },
    },
  });
  return { loader, updates: () => updates };
}

test('toolbox loading registers motion and number shadows before the first workspace update', () => {
  const { loader, updates } = toolboxLoader();
  loader.loadLibToolbox(motion.createCrazyflieMotionToolbox(true));
  assert.equal(updates(), 1);
});

test('refreshing basic categories registers existing motion entries before any workspace update', () => {
  const { loader, updates } = toolboxLoader();
  loader.translateService = { currentLang: 'zh-CN' };
  loader.toolbox.contents.push(motion.createCrazyflieMotionToolbox(true));
  loader.loadCrazyflieBasicBlocks();
  assert.equal(updates(), 7);
  assert.deepEqual(plain(loader.toolbox.contents.slice(-2).map(item => item.name)), ['Crazyflie', 'Crazyradio']);
  const radioCategory = loader.toolbox.contents.at(-1);
  assert.deepEqual(plain(radioCategory.contents.map(item => item.type)),
    ['cf_test_link', 'cf_scan_links', 'cf_radio_config', 'cf_link_config']);
});

test('flight and radio categories are separated from basic blocks with a themed accessible divider', () => {
  const pane = path.join(root, 'src', 'app', 'editors', 'blockly-editor', 'components', 'blockly',
    'components', 'blockly-toolbox-pane');
  const html = fs.readFileSync(path.join(pane, 'blockly-toolbox-pane.component.html'), 'utf8');
  const style = fs.readFileSync(path.join(pane, 'blockly-toolbox-pane.component.scss'), 'utf8');
  assert.match(html, /class="flight-toolbox-divider" role="separator"/);
  assert.ok(html.indexOf('flight-toolbox-divider') < html.indexOf('class="deck-crazyflie"'));
  assert.ok(html.indexOf('crazyradioRootItem') > html.indexOf('class="deck-crazyflie"'));
  assert.match(style, /\.flight-toolbox-divider\s*\{[^}]*border-top: 1px solid var\(--aily-border-input\)/);
});

test('removing the legacy library retains built-in Crazyradio definitions and generators', () => {
  const { loader } = toolboxLoader();
  loader.loadLibToolbox(motion.createCrazyflieMotionToolbox(true));
  loader.blockDefinitionsMap = new Map();
  loader.blockTypeToLibMap = new Map();
  loader.loadedGenerators = new Map([['legacy-generator', new Set(['cf_test_link', 'cf_link_config'])]]);
  const { crazyflieGenerator } = load(path.join(generators, 'basic-blocks.ts'));
  bridgeWindow.MPY = crazyflieGenerator;
  loader.removeLibBlocks([{ type: 'cf_test_link' }, { type: 'cf_link_config' }]);
  loader.removeLibGenerator('legacy-generator');
  for (const type of ['cf_test_link', 'cf_link_config']) {
    assert.ok(require('blockly').Blocks[type], type);
    assert.equal(typeof crazyflieGenerator.forBlock[type], 'function', type);
  }
});

test('legacy flight blocks use concise bilingual labels and the motion palette without changing deck colours', () => {
  const { loader } = toolboxLoader();
  const definitions = JSON.parse(fs.readFileSync(path.join(root, 'child', 'boards', 'board-crazyflie',
    'template', 'node_modules', '@aily-project', 'lib-crazyflie-motion', 'block.json'), 'utf8'));
  const original = JSON.stringify(definitions);
  const Blockly = require('blockly');
  for (const [language, labels] of [
    ['zh', ['连接', '检测电台', '自检']],
    ['en', ['Connect', 'Check radio', 'Self-test']],
  ]) {
    loader.crazyflieBlockLanguage = language;
    const translated = loader.applyCrazyflieBlockLanguage(definitions);
    for (const [index, type] of ['cf_crazyflie_link', 'cf_test_link', 'cf_test_crazyflie_link'].entries()) {
      assert.equal(translated.find(block => block.type === type).message0, labels[index]);
    }
    Blockly.defineBlocksWithJsonArray(translated);
    load(path.join(generators, 'radio-blocks.ts')).registerCrazyradioBlocks(
      load(path.join(generators, 'basic-blocks.ts')).crazyflieGenerator, language === 'zh');
    motion.registerCrazyflieMotionBlocks(load(path.join(generators, 'basic-blocks.ts')).crazyflieGenerator,
      language === 'zh');
    const workspace = new Blockly.Workspace();
    try {
      for (const type of ['cf_link_config', 'cf_crazyflie_link', 'cf_test_link', 'cf_test_crazyflie_link',
        'cf_takeoff', 'cf_land', ...motion.motionBlocks.map(spec => spec.type)]) {
        assert.equal(workspace.newBlock(type).getColour(), '#4a87c6', type);
      }
      const multiranger = translated.find(block => block.type === 'cf_detect_multiranger');
      assert.equal(multiranger.colour, definitions.find(block => block.type === multiranger.type).colour);
    } finally { workspace.dispose(); }
  }
  assert.equal(JSON.stringify(definitions), original, 'do not rewrite installed project definitions');
});

test('Crazyflie hides duplicate generic buttons and routes menu/F6 run through the selected mode', async () => {
  const { HeaderComponent } = load(path.join(root, 'src', 'app', 'main-window', 'components',
    'header', 'header.component.ts'));
  const header = Object.create(HeaderComponent.prototype);
  header.canShowSimulatorControls = () => true;
  assert.equal(header.shouldShowHeaderButton({ action: 'compile' }), false);
  assert.equal(header.shouldShowHeaderButton({ action: 'upload' }), false);
  assert.equal(header.shouldShowHeaderButton({ action: 'other' }), true);
  let runs = 0;
  header.runSelectedCrazyflieMode = async () => { runs++; };
  await header.onClick({ action: 'upload' }, {});
  assert.equal(runs, 1);
  header.canShowSimulatorControls = () => false;
  assert.equal(header.shouldShowHeaderButton({ action: 'compile' }), true);
  assert.equal(header.shouldShowHeaderButton({ action: 'upload' }), true);
});

function uploaderHarness(run) {
  const sim = simulator();
  const notices = [];
  const errors = [];
  const listeners = new Set();
  let flowLog;
  let cancelled = 0;
  let plans = 0;
  let simulations = 0;
  const code = 'cf_crazyflie_link()\ncf_motion("takeoff", [0.3, 0.2])\ncf_motion("land", [0.2])';
  const api = {
    testLink: async () => ({ success: true }),
    startAttitude: async () => ({ success: true }),
    stopAttitude: async () => ({ success: true }),
    onAttitude: callback => { listeners.add(callback); return () => listeners.delete(callback); },
    onFlowLog: callback => { flowLog = callback; return () => { flowLog = null; }; },
    cancelFlow: async () => { cancelled++; return { success: true }; },
    runFlow: options => run({
      options, sim, emit: event => { for (const callback of listeners) callback(event); },
      log: line => flowLog?.({ line }),
    }),
  };
  bridgeWindow.crazyflie = api;
  bridgeWindow.electronAPI = { crazyflie: api };
  bridgeWindow.MPY = {};
  const uploader = Object.create(_UploaderService.prototype);
  Object.assign(uploader, {
    zone: { run: fn => fn() }, crazyflieFlowActive: false, crazyflieCancelRequested: false,
    projectService: { getBoardModule: async () => '@aily-project/board-crazyflie' },
    serialService: { currentPortInfo: null }, crazyflieSimService: sim,
    crazyflieTelemetryService: { clear() {}, setTelemetry() {} },
    crazyflieConnectionService: {
      state$: new (require('rxjs').BehaviorSubject)({ status: 'unknown' }),
      setChecking() {}, setResult() {}, setDeckDetected() {},
    },
    noticeService: { update: notice => notices.push(notice) }, logService: { update() {} },
    message: { error: message => errors.push(message) },
    clearBlocklySelection() {}, highlightCrazyflieBlock() {},
    prepareCrazyflieFlow() { plans++; return { code, executionBlocks: [] }; },
  });
  sim.runCode = async () => { simulations++; return { success: true, executed: [] }; };
  return { uploader, sim, notices, errors, listeners, api,
    get cancelled() { return cancelled; }, get plans() { return plans; },
    get simulations() { return simulations; }, get flowLog() { return flowLog; } };
}

test('combined mode compiles once, executes once, follows telemetry during flight and releases subscriptions', async () => {
  const h = uploaderHarness(async ({ options, sim, emit, log }) => {
    assert.equal(options.followPosition, true);
    assert.equal(sim.followingReal$.value, true);
    emit(sample(0));
    emit(sample(50, { x: 0.5, y: 0.2, z: 0.3, yaw: 45 }));
    near(sim.pose$.value.x, -0.5);
    near(sim.pose$.value.z, 0.2);
    near(sim.pose$.value.y, 1.06573);
    log('__STEP__:2/3:takeoff');
    assert.equal(sim.step$.value.current, 2);
    return { success: true, executed: ['crazyflie_link'] };
  });
  const result = await h.uploader.runCrazyflieSimAndReal();
  assert.equal(result.state, 'done');
  assert.equal(h.plans, 1);
  assert.equal(h.simulations, 0, 'must not run an idealized simulation before flight');
  assert.equal(h.sim.followingReal$.value, false);
  assert.equal(h.sim.running$.value, false);
  assert.equal(h.sim.poseSource$.value, 'real');
  assert.equal(h.listeners.size, 0);
  assert.equal(h.flowLog, null);
});

test('real-only does not start synchronization, while simulation does not call the flight bridge', async () => {
  let flights = 0;
  const h = uploaderHarness(async ({ options, sim }) => {
    flights++;
    assert.equal(options.followPosition, false);
    assert.equal(sim.poseSource$.value, 'simulation');
    assert.equal(h.listeners.size, 0);
    return { success: true, executed: [] };
  });
  assert.equal((await h.uploader.runCrazyflieRealOnly()).state, 'done');
  assert.equal((await h.uploader.simulateCrazyflie()).state, 'done');
  assert.equal(flights, 1);
  assert.equal(h.simulations, 1);
});

test('radio scans use the flow runner and configuration-only results never claim a verified connection', async () => {
  for (const [code, executed] of [
    ['cf_scan_links()', ['scan_links']],
    ['cf_set_link("radio://0/80/2M", "E7E7E7E7E7")', ['set_link:radio://0/80/2M:E7E7E7E7E7']],
  ]) {
    let runs = 0;
    const h = uploaderHarness(async ({ options }) => {
      runs++;
      assert.equal(options.code, code);
      return { success: true, executed, links: [] };
    });
    h.uploader.prepareCrazyflieFlow = () => ({ code, executionBlocks: [] });
    assert.equal((await h.uploader.runCrazyflieRealOnly()).state, 'done');
    assert.equal(runs, 1);
    if (executed[0].startsWith('set_link')) {
      assert.equal(h.uploader.crazyflieConnectionService.state$.value.status, 'unknown');
    }
  }
});

test('missing/invalid telemetry cannot return success and active cancellation waits for the flow to finish', async () => {
  for (const fault of ['missing', 'invalid', 'error', 'throw']) {
    const h = uploaderHarness(async ({ emit }) => {
      if (fault === 'invalid') emit({ ...sample(1), z: NaN });
      if (fault === 'error') emit({ type: 'error', message: 'no fresh data' });
      if (fault === 'throw') throw new Error('bridge failed');
      return { success: true, executed: [] };
    });
    if (fault === 'throw') await assert.rejects(h.uploader.runCrazyflieSimAndReal(), /bridge failed/);
    else assert.equal((await h.uploader.runCrazyflieSimAndReal()).state, 'error');
    assert.equal(h.sim.running$.value, false);
    assert.equal(h.listeners.size, 0);
    assert.equal(h.flowLog, null);
    if (fault === 'invalid' || fault === 'error') assert.equal(h.cancelled, 1);
  }
  let finish;
  const h = uploaderHarness(({ emit }) => {
    emit(sample(0));
    return new Promise(resolve => { finish = resolve; });
  });
  const running = h.uploader.runCrazyflieSimAndReal();
  await new Promise(resolve => setImmediate(resolve));
  h.uploader.cancel();
  assert.equal(h.cancelled, 1);
  assert.equal(h.sim.running$.value, true, 'do not claim a flying vehicle has already stopped');
  assert.equal((await h.uploader.runCrazyflieRealOnly()).state, 'error');
  finish({ success: true, executed: [] });
  assert.equal((await running).state, 'warn');
  assert.equal(h.sim.running$.value, false);

  const failedCancel = uploaderHarness(({ emit }) => {
    emit(sample(0));
    return new Promise(resolve => { finish = resolve; });
  });
  failedCancel.api.cancelFlow = async () => ({ success: false, message: 'control channel closed' });
  const active = failedCancel.uploader.runCrazyflieSimAndReal();
  await new Promise(resolve => setImmediate(resolve));
  failedCancel.uploader.cancel();
  await new Promise(resolve => setImmediate(resolve));
  assert.match(failedCancel.errors[0], /取消请求失败/);
  finish({ success: true, executed: [] });
  assert.equal((await active).state, 'error');
});

test('Python synchronized logger emits same-packet XYZ/RPY, gates missing data, tracks estimator resets and removes callbacks', () => {
  const result = spawnSync('py', ['-3', '-B', '-c', `
import sys, types, time
from threading import Event
from pathlib import Path
sys.path.insert(0, str(Path('child') / 'scripts'))
import crazyflie_attitude as observer
class Callback:
    def __init__(self): self.callbacks = []
    def add_callback(self, cb): self.callbacks.append(cb)
    def remove_callback(self, cb): self.callbacks.remove(cb)
    def call(self, *args):
        for cb in list(self.callbacks): cb(*args)
configs, samples = [], []
mode = ['ok']
class Config:
    def __init__(self, name, period_in_ms):
        self.data_received_cb, self.error_cb = Callback(), Callback()
        self.names, self.deleted = [], False
        configs.append(self)
    def add_variable(self, name, kind):
        assert kind == 'float'
        self.names.append(name)
    def start(self):
        data = dict(zip(['stabilizer.roll','stabilizer.pitch','stabilizer.yaw',
                         'stateEstimate.x','stateEstimate.y','stateEstimate.z'], [1,2,3,4,5,6]))
        if mode[0] == 'missing': del data['stateEstimate.x']
        self.data_received_cb.call(100, data, self)
    def stop(self): pass
    def delete(self): self.deleted = True
reset_callbacks = []
def add_update_callback(**kwargs): reset_callbacks.append(kwargs['cb'])
def remove_update_callback(**kwargs): reset_callbacks.remove(kwargs['cb'])
scf = types.SimpleNamespace(cf=types.SimpleNamespace(
    log=types.SimpleNamespace(add_config=lambda cfg: None), disconnected=Callback(),
    param=types.SimpleNamespace(add_update_callback=add_update_callback,
                               remove_update_callback=remove_update_callback)))
for name in ['cflib','cflib.crazyflie','cflib.crazyflie.log']:
    sys.modules[name] = types.ModuleType(name)
sys.modules['cflib.crazyflie.log'].LogConfig = Config
with observer.attitude_logging(scf, samples.append, follow_position=True) as healthy:
    healthy()
    assert samples[0] == dict(type='sample',timestampMs=100,roll=1,pitch=2,yaw=3,x=4,y=5,z=6), samples
    reset_callbacks[0]('kalman.resetEstimation', '0')
    assert samples[-1] == {'type':'reference'}
assert len(configs[-1].names) == 6 and configs[-1].deleted
assert not reset_callbacks and not scf.cf.disconnected.callbacks
mode[0] = 'missing'
try:
    with observer.attitude_logging(scf, samples.append, follow_position=True):
        raise AssertionError('missing XYZ was allowed to start flight')
except RuntimeError as error:
    assert 'Flight pose logging failed' in str(error), error
assert not reset_callbacks and configs[-1].deleted
print('pose logging gate and cleanup passed')
`], { cwd: root, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
});

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { spawn, spawnSync } = require('node:child_process');
const { test } = require('node:test');
const ts = require('typescript');
const { Vector3, Quaternion, Group } = require('three');

const root = path.resolve(__dirname, '..');
const helperPath = path.join(root, 'src', 'app', 'services', 'crazyflie-attitude.ts');
const helperJs = ts.transpileModule(fs.readFileSync(helperPath, 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const helper = { exports: {} };
const helperContext = { exports: helper.exports, require, window: {} };
vm.runInNewContext(helperJs, helperContext);
const { attitudeQuaternion, AttitudeReception, isAttitudeSample } = helper.exports;
const classroom = { exports: {} };
vm.runInNewContext(ts.transpileModule(fs.readFileSync(path.join(root, 'src', 'app', 'services',
  'crazyflie-classroom.ts'), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText, { exports: classroom.exports });
const { getClassroomDeskLayout } = classroom.exports;
const sample = (timestampMs, yaw = 0) => ({ type: 'sample', timestampMs, roll: 0, pitch: 0, yaw });
const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-6, `${a} != ${b}`);
const vectorNear = (actual, expected) => actual.toArray().forEach((n, i) => near(n, expected[i]));

test('attitude quaternion maps firmware yaw/roll/legacy pitch into model and flight coordinates', () => {
  const forward = new Vector3(1, 0, 0);
  const up = new Vector3(0, 1, 0);
  vectorNear(forward.clone().applyQuaternion(attitudeQuaternion(0, 0, 0, Math.PI)), [-1, 0, 0]);
  vectorNear(forward.clone().applyQuaternion(attitudeQuaternion(0, 0, 90, Math.PI)), [0, 0, 1]);
  vectorNear(forward.clone().applyQuaternion(attitudeQuaternion(0, 90, 0, Math.PI)), [0, 1, 0]);
  vectorNear(up.clone().applyQuaternion(attitudeQuaternion(90, 0, 0, Math.PI)), [0, 0, -1]);
  const combined = attitudeQuaternion(30, 20, 60);
  const reference = new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), Math.PI / 3)
    .multiply(new Quaternion().setFromAxisAngle(new Vector3(0, 0, 1), -Math.PI / 9))
    .multiply(new Quaternion().setFromAxisAngle(new Vector3(-1, 0, 0), Math.PI / 6));
  near(combined.angleTo(reference), 0);
});

test('quaternion interpolation crosses +179/-179 by two degrees instead of a full turn', () => {
  const a = attitudeQuaternion(0, 0, 179, Math.PI);
  const b = attitudeQuaternion(0, 0, -179, Math.PI);
  near(a.angleTo(b), Math.PI / 90);
  const middle = a.clone().slerp(b, 0.5);
  vectorNear(new Vector3(1, 0, 0).applyQuaternion(middle), [1, 0, 0]);
});

test('receive metrics measure local cadence and age, reject invalid/duplicate data and accept timestamp wrap', () => {
  const reception = new AttitudeReception();
  assert.equal(reception.metrics(0).stale, true);
  assert.equal(reception.metrics(0).ageMs, null);
  for (let i = 0; i < 40; i++) assert.equal(reception.receive(sample(i * 50), i * 50), true);
  near(reception.metrics(1950).hz, 20);
  assert.equal(reception.metrics(1950).stale, false);
  assert.equal(reception.receive(sample(1950), 1960), false);
  assert.equal(reception.receive({ ...sample(2000), roll: NaN }, 2000), false);
  assert.equal(isAttitudeSample({ ...sample(2000), pitch: '1' }), false);
  assert.equal(reception.metrics(2451).stale, true);
  assert.equal(reception.metrics(2451).ageMs, 501);
  reception.receive(sample(0xfffff0), 2500);
  assert.equal(reception.receive(sample(10), 2550), true);
  near(reception.metrics(5000).hz, 0);
});

test('Python continuous logger stays read-only, emits fresh RPY, and cleans up on stop/error/timeout/disconnection', () => {
  const result = spawnSync('py', ['-3', '-B', '-c', `
import sys, runpy, types
from pathlib import Path
from threading import Event
sys.path.insert(0, str(Path('child') / 'scripts'))
ns = runpy.run_path(str(Path('child') / 'scripts' / 'crazyflie_attitude.py'), run_name='attitude_test')
stream = ns['stream_attitude']
class Callback:
    def __init__(self): self.callbacks = []
    def add_callback(self, cb): self.callbacks.append(cb)
    def remove_callback(self, cb): self.callbacks.remove(cb)
    def call(self, *args):
        for cb in list(self.callbacks): cb(*args)
configs, results = [], []
mode = ['ok']
stopped = Event()
disconnected = Callback()
class Config:
    def __init__(self, name, period_in_ms):
        assert period_in_ms == 50
        self.data_received_cb, self.error_cb = Callback(), Callback()
        self.names, self.stopped, self.deleted = [], False, False
        configs.append(self)
    def add_variable(self, name, kind):
        assert kind == 'float'
        self.names.append(name)
    def start(self):
        data = {'stabilizer.roll': 12.5, 'stabilizer.pitch': -4.5, 'stabilizer.yaw': 179}
        if mode[0] == 'ok':
            self.data_received_cb.call(123, data, self)
            data['stabilizer.yaw'] = -179
            self.data_received_cb.call(173, data, self)
            stopped.set()
        elif mode[0] == 'invalid':
            data['stabilizer.roll'] = float('nan')
            self.data_received_cb.call(123, data, self)
        elif mode[0] == 'error': self.error_cb.call(self, 'test log error')
        elif mode[0] == 'disconnect': disconnected.call('radio://mock')
        elif mode[0] == 'start_error': raise RuntimeError('failed to start log')
    def stop(self): self.stopped = True
    def delete(self): self.deleted = True
def add_config(config):
    if mode[0] == 'toc': raise KeyError('missing attitude variable')
scf = types.SimpleNamespace(cf=types.SimpleNamespace(log=types.SimpleNamespace(add_config=add_config),
                                                    disconnected=disconnected))
stream(scf, Config, stopped, results.append)
assert results == [
    {'type':'sample', 'timestampMs':123, 'roll':12.5, 'pitch':-4.5, 'yaw':179},
    {'type':'sample', 'timestampMs':173, 'roll':12.5, 'pitch':-4.5, 'yaw':-179}]
for fault, exception in [('invalid', RuntimeError), ('error', RuntimeError), ('disconnect', RuntimeError),
                         ('silent', TimeoutError), ('start_error', RuntimeError), ('toc', KeyError)]:
    stopped.clear()
    mode[0] = fault
    try: stream(scf, Config, stopped, results.append, stale_sec=0.01)
    except exception: pass
    else: raise AssertionError(fault)
    if fault != 'toc':
        assert configs[-1].stopped and configs[-1].deleted, fault
        assert not configs[-1].data_received_cb.callbacks and not configs[-1].error_cb.callbacks, fault
    assert not disconnected.callbacks, fault
print('continuous read-only logger passed')
`], { cwd: root, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
});

test('Python flow shares one connection with attitude logging, retains it during waits, and survives logger failure', () => {
  const result = spawnSync('py', ['-3', '-B', '-c', `
import sys, types, io, json, time
from contextlib import redirect_stdout
from pathlib import Path
from threading import Event, Thread
sys.path.insert(0, str(Path('child') / 'scripts'))
import crazyflie_run_flow as runner
modules = {}
for name in ['cflib', 'cflib.crtp', 'cflib.crazyflie', 'cflib.crazyflie.syncCrazyflie',
             'cflib.crazyflie.log', 'cflib.crazyflie.syncLogger', 'cflib.positioning',
             'cflib.positioning.motion_commander', 'cflib.crtp.radiodriver',
             'cflib.utils', 'cflib.utils.multiranger']:
    module = types.ModuleType(name)
    modules[name] = sys.modules[name] = module
    if '.' in name:
        parent, attr = name.rsplit('.', 1)
        setattr(modules[parent], attr, module)
class Callback:
    def __init__(self): self.callbacks = []
    def add_callback(self, cb): self.callbacks.append(cb)
    def remove_callback(self, cb): self.callbacks.remove(cb)
    def call(self, *args):
        for cb in list(self.callbacks): cb(*args)
connections, configurations, commands = [], [], []
active = [0]
bad_logger = [False]
class Config:
    def __init__(self, name, period_in_ms):
        if name != 'AilyAttitude': raise RuntimeError('battery telemetry not available in this mock')
        self.data_received_cb, self.error_cb = Callback(), Callback()
        self.stopped, self.deleted = Event(), False
        self.worker = None
        configurations.append(self)
    def add_variable(self, *args): pass
    def start(self):
        if bad_logger[0]: raise RuntimeError('mock attitude unavailable')
        def produce():
            timestamp = 0
            while not self.stopped.is_set():
                self.data_received_cb.call(timestamp, {'stabilizer.roll': 15,
                    'stabilizer.pitch': -10, 'stabilizer.yaw': 30}, self)
                timestamp += 50
                self.stopped.wait(0.05)
        self.worker = Thread(target=produce)
        self.worker.start()
    def stop(self):
        self.stopped.set()
        if self.worker: self.worker.join()
    def delete(self): self.deleted = True
class Connection:
    def __init__(self, uri):
        self.cf = types.SimpleNamespace(
            platform=types.SimpleNamespace(send_arming_request=lambda value: commands.append('arm')),
            log=types.SimpleNamespace(add_config=lambda config: None),
            disconnected=Callback())
        connections.append(self)
    def __enter__(self):
        active[0] += 1
        assert active[0] == 1, 'attitude must not open a second connection'
        return self
    def __exit__(self, *args):
        active[0] -= 1
        assert all(c.deleted and c.stopped.is_set() for c in configurations)
class Commander:
    def __init__(self, scf): assert scf is connections[-1]
    def take_off(self, **kwargs): commands.append('takeoff')
    def stop(self): commands.append('hover')
    def land(self, **kwargs): commands.append('land')
modules['cflib.crtp'].init_drivers = lambda **kwargs: None
modules['cflib.crazyflie.syncCrazyflie'].SyncCrazyflie = Connection
modules['cflib.crazyflie.log'].LogConfig = Config
modules['cflib.crazyflie.syncLogger'].SyncLogger = object
modules['cflib.positioning.motion_commander'].MotionCommander = Commander
modules['cflib.crtp.radiodriver'].RadioDriver = lambda: types.SimpleNamespace(get_status=lambda: 'mock radio')
modules['cflib.utils.multiranger'].Multiranger = object
idle = runner.parse_commands('cf_crazyflie_link()\\ncf_delay(0.2)\\ncf_print("done")')
out = io.StringIO()
with redirect_stdout(out):
    result = runner.run_flow('radio://mock', idle, 'E7E7E7E7E7', attitude=True)
assert result['success'], result
assert len(connections) == 1 and not commands, 'monitoring must not arm or move motors'
samples = [json.loads(line.split(':', 1)[1]) for line in out.getvalue().splitlines()
           if line.startswith('__ATTITUDE__:')]
assert len([s for s in samples if s['type'] == 'sample']) >= 3, samples
assert all(not c.data_received_cb.callbacks for c in configurations)
flight = runner.parse_commands('cf_crazyflie_link()\\ncf_motion("takeoff", [0.5,0.2])\\ncf_motion("hover", [0.1])\\ncf_motion("land", [0.2])')
for failure in [False, True]:
    bad_logger[0] = failure
    connections.clear()
    configurations.clear()
    commands.clear()
    out = io.StringIO()
    with redirect_stdout(out):
        result = runner.run_flow('radio://mock', flight, 'E7E7E7E7E7', attitude=True)
    assert result['success'], result
    assert len(connections) == 1 and active[0] == 0
    assert commands == ['arm', 'takeoff', 'hover', 'land', 'land'], commands
    if failure: assert 'mock attitude unavailable' in out.getvalue()
print('shared idle/flight connection and logger error isolation passed')
`], { cwd: root, encoding: 'utf8', timeout: 15000 });
  assert.equal(result.status, 0, result.stderr || String(result.error));
});

function monitorHarness(spawnOverride) {
  const filename = path.join(root, 'electron', 'crazyflie-attitude.js');
  const exports = {};
  let child;
  const timers = new Map();
  const context = {
    exports, module: { exports },
    require: name => name === 'child_process' ? { spawn: spawnOverride || (() => {
      child = new EventEmitter();
      child.stdin = new PassThrough();
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      child.kill = () => { child.emit('close', -1); };
      return child;
    }) } : require(name),
    setTimeout: (fn, ms) => { const token = {}; timers.set(token, { fn, ms }); return token; },
    clearTimeout: token => timers.delete(token),
  };
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), context);
  const sender = new EventEmitter();
  sender.id = 1;
  sender.isDestroyed = () => false;
  const messages = [];
  sender.send = (channel, payload) => messages.push({ channel, payload });
  let closed = 0;
  const monitor = context.module.exports.startAttitudeMonitor({
    sender, pythonCmd: 'py', scriptPath: 'mock', connectionArgs: [], onClose: () => closed++,
  });
  return { monitor, sender, messages, child, timers, get closed() { return closed; } };
}
const tick = () => new Promise(resolve => setImmediate(resolve));

test('Electron stream handles chunk boundaries, explicit errors, startup timeout, graceful stop and owner destruction', async () => {
  const h = monitorHarness();
  h.child.stdout.write('diagnostic\n{"type":"sample","roll":1,');
  h.child.stdout.write('"pitch":2,"yaw":3,"timestampMs":50}\n');
  await tick();
  assert.equal(h.messages.length, 1);
  assert.equal(h.messages[0].payload.yaw, 3);
  assert.equal(h.timers.size, 0);
  let stopInput = '';
  h.child.stdin.on('data', chunk => { stopInput += chunk; });
  const done = h.monitor.stop();
  assert.equal(stopInput, 'stop\n');
  h.child.emit('close', 0);
  await done;
  assert.equal(h.closed, 1);
  assert.equal(h.messages.at(-1).payload.type, 'stopped');
  assert.equal(h.timers.size, 0);
  assert.equal(h.sender.listenerCount('destroyed'), 0);

  for (const trigger of ['destroyed', 'navigation', 'crash', 'invalid', 'timeout', 'spawn']) {
    const current = monitorHarness();
    if (trigger === 'navigation') current.sender.emit('did-start-navigation', null, 'url', false, true);
    else if (trigger === 'crash') current.sender.emit('render-process-gone');
    else if (trigger === 'invalid') {
      current.child.stdout.write('{"type":"sample","roll":"bad","pitch":0,"yaw":0,"timestampMs":0}\n');
      await tick();
    } else if (trigger === 'timeout') {
      [...current.timers.values()].find(timer => timer.ms === 15000).fn();
    } else if (trigger === 'spawn') {
      current.child.emit('error', new Error('missing Python'));
    } else current.sender.emit('destroyed');
    current.child.emit('close', 1);
    await tick();
    assert.equal(current.closed, 1, trigger);
    assert.equal(current.timers.size, 0, trigger);
    if (['invalid', 'timeout', 'spawn'].includes(trigger)) {
      assert.ok(current.messages.some(item => item.payload.type === 'error'), trigger);
    }
  }
});

test('actual Python pipe -> Electron message path sustains at least 15 Hz for a synthetic 20 Hz source', async () => {
  const code = [
    'import json, time',
    'start = time.perf_counter()',
    'for i in range(40):',
    ' print(json.dumps({"type":"sample", "timestampMs": i*50, "roll": i, "pitch": -i, "yaw": i}), flush=True)',
    ' time.sleep(max(0, start + (i+1)*0.05 - time.perf_counter()))',
  ].join('\n');
  let process;
  const received = [];
  const h = monitorHarness(() => {
    process = spawn('py', ['-3', '-B', '-u', '-c', code], { stdio: ['pipe', 'pipe', 'pipe'] });
    return process;
  });
  h.sender.send = (channel, payload) => {
    if (payload.type === 'sample') received.push({ at: performance.now(), payload });
  };
  try {
    await new Promise((resolve, reject) => {
      process.once('close', resolve);
      process.once('error', reject);
    });
    assert.equal(received.length, 40);
    const rate = 39000 / (received.at(-1).at - received[0].at);
    assert.ok(rate >= 15 && rate <= 26, `Observed local transport rate ${rate.toFixed(2)} Hz`);
    assert.equal(received.at(-1).payload.roll, 39);
    console.log(`Synthetic local attitude transport: ${rate.toFixed(2)} Hz (not a radio/physical latency measurement)`);
  } finally {
    await h.monitor.stop();
  }
});

test('Electron hands idle monitoring to the flow connection, forwards attitude without log spam and resumes afterwards', async () => {
  const filename = path.join(root, 'electron', 'crazyflie.js');
  const handlers = new Map();
  let options;
  let stopCount = 0;
  let startCount = 0;
  let activeMonitors = 0;
  let flowChild;
  let flowArgs;
  const messages = [];
  const exports = {};
  const context = {
    exports, module: { exports }, process: { env: {} }, __dirname: path.dirname(filename),
    require: name => name === 'electron' ? { ipcMain: { handle: (key, fn) => handlers.set(key, fn) } }
      : name === './crazyflie-attitude' ? { startAttitudeMonitor: config => {
        assert.equal(activeMonitors, 0, 'only one idle connection may exist');
        startCount++;
        activeMonitors++;
        options = config;
        return { senderId: config.sender.id, stop: async () => {
          stopCount++;
          await tick();
          activeMonitors--;
          config.onClose();
        } };
      } } : name === 'child_process' ? {
        spawn: (_python, args) => {
          assert.equal(activeMonitors, 0, 'monitor must close before flow acquires the radio');
          flowArgs = args;
          flowChild = new EventEmitter();
          flowChild.stdout = new PassThrough();
          flowChild.stderr = new PassThrough();
          flowChild.kill = () => flowChild.emit('close', 1);
          return flowChild;
        },
        execFile: (_python, _args, _options, callback) => {
          assert.equal(activeMonitors, 0, 'monitor must close before a link test');
          callback(null, '{"success":true,"message":"Link OK"}', '');
        },
      } : name === 'fs' ? { existsSync: () => false } : require(name),
    Buffer, setTimeout, clearTimeout,
  };
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), context);
  context.module.exports.registerCrazyflieHandlers();
  const sender = new EventEmitter();
  sender.id = 1;
  sender.isDestroyed = () => false;
  sender.send = (channel, payload) => messages.push({ channel, payload });
  const event = { sender };
  const opts = { uri: 'radio://0/80/2M', addressHex: 'E7E7E7E7E7' };
  assert.equal(handlers.get('crazyflie-start-attitude')(event, { ...opts, uri: 'invalid' }).success, false);
  assert.equal(handlers.get('crazyflie-start-attitude')(event, opts).success, true);
  assert.ok(options.scriptPath.endsWith('crazyflie_attitude.py'));
  assert.equal(handlers.get('crazyflie-start-attitude')(event, opts).success, false);
  assert.equal((await handlers.get('crazyflie-run-flow')({ sender: { id: 2 } }, {})).radioStatus, 'busy');
  assert.equal((await handlers.get('crazyflie-stop-attitude')({ sender: { id: 2 } })).success, false);
  assert.equal(stopCount, 0);
  const flow = handlers.get('crazyflie-run-flow')(event, { ...opts, code: 'cf_crazyflie_link()' });
  assert.equal((await handlers.get('crazyflie-test-link')(event, opts)).radioStatus, 'busy');
  await tick();
  await tick();
  assert.ok(flowArgs.includes('--attitude'));
  flowChild.stdout.write('__ATTITUDE__:{"type":"sample","timestampMs":50,"roll":12,');
  flowChild.stdout.write('"pitch":-4,"yaw":30}\n__STEP__:1/1:connect\n');
  flowChild.stdout.write('{"success":true,"message":"Flow executed","executed":["crazyflie_link"]}\n');
  flowChild.emit('close', 0);
  assert.equal((await flow).success, true);
  assert.equal(messages.filter(item => item.channel === 'crazyflie-attitude' && item.payload.type === 'sample').length, 1);
  assert.equal(messages.filter(item => item.channel === 'crazyflie-flow-log').length, 1);
  assert.equal(messages.find(item => item.channel === 'crazyflie-flow-log').payload.line, '__STEP__:1/1:connect');
  assert.equal(startCount, 2, 'idle monitoring resumes after flow');
  assert.equal((await handlers.get('crazyflie-test-link')(event, opts)).success, true);
  assert.equal(startCount, 3);
  assert.equal((await handlers.get('crazyflie-stop-attitude')(event)).success, true);
  assert.equal(stopCount, 3);
  assert.equal(activeMonitors, 0);
  const secondFlow = handlers.get('crazyflie-run-flow')(event, { ...opts, code: 'cf_crazyflie_link()' });
  await tick();
  assert.equal(handlers.get('crazyflie-start-attitude')(event, opts).success, true,
    'display can be enabled while the flow is running');
  assert.equal(activeMonitors, 0);
  flowChild.stdout.write('__ATTITUDE__:{"type":"sample","timestampMs":100,"roll":2,"pitch":3,"yaw":4}\n');
  assert.equal(messages.filter(item => item.channel === 'crazyflie-attitude' && item.payload.type === 'sample').length, 2);
  assert.equal((await handlers.get('crazyflie-stop-attitude')(event)).success, true);
  flowChild.stdout.write('{"success":true,"message":"Flow executed"}\n');
  flowChild.emit('close', 0);
  assert.equal((await secondFlow).success, true);
  assert.equal(activeMonitors, 0, 'turning display off during flow must not reconnect afterwards');
  assert.equal(handlers.get('crazyflie-start-attitude')(event, opts).success, true);
  sender.emit('did-start-navigation', null, 'url', false, true);
  await tick();
  assert.equal(activeMonitors, 0);
  assert.equal(sender.listenerCount('destroyed'), 0);
});

test('classroom uses natural wood finishes without loose books or extra cabinets', () => {
  const filename = path.join(root, 'src', 'app', 'editors', 'blockly-editor', 'components', 'blockly',
    'components', 'crazyflie-sim-panel', 'crazyflie-sim-panel.component.ts');
  const source = fs.readFileSync(filename, 'utf8');
  assert.match(source, /createLightClassroomTexture\(map, '#f1dfbf', 0\.65\)/);
  assert.match(source, /createLightClassroomTexture\(map, '#dfb270', 0\.42\)/);
  assert.match(source, /createLightClassroomTexture\(map, '#d7a968', 0\.28\)/);
  assert.match(source, /this\.applyVarnishedPineFinish\(lecternPanels\)/);
  assert.doesNotMatch(source, /applyVarnishedPineFinish\(podiumGroup\)/);
  assert.doesNotMatch(source, /loadClassroomProtoAsset\('school_furniture\/protos\/Book\.proto'\)/);
  assert.doesNotMatch(source, /Webots school book|cabinetGroup|lowShelfGroup/);
});

function panelHarness({ globals = {}, three = require('three') } = {}) {
  const filename = path.join(root, 'src', 'app', 'editors', 'blockly-editor', 'components', 'blockly',
    'components', 'crazyflie-sim-panel', 'crazyflie-sim-panel.component.ts');
  const js = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, experimentalDecorators: true },
  }).outputText;
  let now = 0;
  let frame;
  const exports = {};
  const context = {
    exports, performance: { now: () => now }, queueMicrotask,
    requestAnimationFrame: callback => { frame = callback; return 1; }, cancelAnimationFrame() {},
    require: name => {
      if (name === '@angular/core') return { Component: () => target => target, ViewChild: () => () => {} };
      if (name === '@angular/common') return {};
      if (name === 'three') return three;
      if (name === 'rxjs') return require(name);
      if (name.endsWith('/crazyflie-attitude')) return helper.exports;
      if (name.endsWith('/crazyflie-classroom')) return classroom.exports;
      if (name.endsWith('/GLTFLoader.js')) return { GLTFLoader: class {} };
      if (name.endsWith('/ColladaLoader.js')) return { ColladaLoader: class {} };
      if (name.endsWith('/RoundedBoxGeometry.js')) return require(name);
      if (name.endsWith('/OrbitControls.js')) return {};
      return {};
    },
    ...globals,
  };
  vm.runInNewContext(js, context);
  const messages = [];
  const sim = { pose$: { value: { x: 0, y: 0, z: 0, yaw: 0 } } };
  const panel = new exports.CrazyflieSimPanelComponent(sim, {}, {},
    { error: text => messages.push(text) }, { run: fn => fn() });
  panel.scene = {};
  panel.camera = {};
  let rendered = 0;
  panel.renderer = { render() { rendered++; } };
  panel.droneGroup = new Group();
  panel.droneGroup.rotation.y = Math.PI;
  panel.droneGroup.position.copy(panel.targetPosition);
  panel.flightAxes = new Group();
  panel.drawOrientationCompass = () => {};
  return {
    panel, messages, sim,
    render(count) {
      if (!frame) panel.startRenderLoop();
      for (let i = 0; i < count; i++) { now += 1000 / 60; frame(); }
    },
    get rendered() { return rendered; },
  };
}

test('imported desk tabletop faces point upward after converting Webots coordinates', async () => {
  const THREE = require('three');
  const canvas = {
    width: 1, height: 1,
    getContext: () => ({
      drawImage() {}, putImageData() {},
      getImageData: () => ({ data: new Uint8ClampedArray(4) }),
    }),
  };
  const panel = panelHarness({
    globals: {
      URL,
      window: { location: { href: 'http://localhost/' } },
      document: { createElement: () => canvas },
      fetch: async () => ({
        ok: true,
        text: async () => fs.readFileSync(path.join(root, 'public', 'models', 'classroom', 'Desk.proto'), 'utf8'),
      }),
    },
    three: { ...THREE, TextureLoader: class {
      async loadAsync() { return new THREE.Texture({}); }
    } },
  }).panel;
  panel.createLightClassroomTexture = () => new THREE.CanvasTexture(canvas);
  const { geometry, material } = await panel.loadClassroomDeskAsset();
  const position = geometry.getAttribute('position');
  const normal = geometry.getAttribute('normal');
  let tabletopVertices = 0;
  try {
    for (let vertex = 0; vertex < position.count; vertex += 1) {
      if (position.getY(vertex) < 0.7098 || Math.abs(normal.getY(vertex)) < 0.99) continue;
      tabletopVertices += 1;
      assert.ok(normal.getY(vertex) > 0.99, 'desktop must face the daylight, not the floor');
    }
    assert.ok(tabletopVertices >= 6, 'test must cover the real tabletop triangles');
  } finally {
    geometry.dispose();
    for (const texture of [material.map, material.normalMap, material.roughnessMap, material.metalnessMap]) texture.dispose();
    material.dispose();
  }
});

test('student desks leave clearance from the teaching area and keep chairs, bags and helipad inside the classroom', () => {
  const { Box3 } = require('three');
  const panel = panelHarness().panel;
  for (const room of [{ width: 8.2 }, { width: 30 }]) {
    const layout = getClassroomDeskLayout();
    const { rows, cols, firstRowX, rowSpacing, deskD, deskW, colCenters, chairOffsetX, helipadRow, helipadCol, helipadPose } = layout;
    assert.equal(rows, 4);
    assert.equal(cols, 5);
    assert.equal(rows * cols, 20);
    near(rowSpacing, 1.3);
    assert.ok(colCenters.every((center, index) => !index || center - colCenters[index - 1] - deskW >= 0.49));
    const teacherDeskBack = -room.width / 2 + 1.55 + 0.31;
    assert.ok(firstRowX - deskD / 2 - teacherDeskBack >= 0.73, 'leave at least 73cm behind the teacher desk');
    const lectern = panel.createClassroomLectern();
    lectern.position.set(-room.width / 2 + 1.36, 0, 1.02);
    lectern.rotation.y = Math.PI / 2;
    assert.ok(firstRowX - deskD / 2 - new Box3().setFromObject(lectern).max.x >= 0.98);
    const lastRowX = firstRowX + rowSpacing * (rows - 1);
    const chair = panel.createClassroomChair();
    chair.position.x = lastRowX + chairOffsetX;
    const bag = panel.createSchoolBackpack('#526c89');
    bag.position.set(lastRowX + chairOffsetX + 0.245, 0.56, 0);
    for (const prop of [chair, bag]) {
      assert.ok(new Box3().setFromObject(prop).max.x < room.width / 2 - 0.08,
        'rear-row furniture must stay inside the back wall');
    }
    near(helipadPose.x, firstRowX + rowSpacing * helipadRow);
    near(helipadPose.z, colCenters[helipadCol]);
    assert.equal(helipadPose.x, 0);
    assert.equal(helipadPose.z, 0);
    near(helipadPose.y, 0.76573);
    assert.ok(0.3 <= deskD && 0.3 <= deskW, 'helipad still fits on its assigned desk');
    for (const prop of [lectern, chair, bag]) prop.traverse(node => {
      node.geometry?.dispose();
      node.material?.dispose();
    });
  }
  near(getClassroomDeskLayout().firstRowX, -1.3);
});

test('school chairs have rounded wood panels, a continuous steel back and four floor-contacting rubber feet', () => {
  const { Box3 } = require('three');
  const chair = panelHarness().panel.createClassroomChair();
  assert.equal(chair.getObjectByName('Chair wood seat').geometry.type, 'RoundedBoxGeometry');
  assert.equal(chair.getObjectByName('Chair wood back').geometry.type, 'RoundedBoxGeometry');
  assert.equal(chair.getObjectByName('Chair bent steel back frame').geometry.type, 'TubeGeometry');
  const feet = chair.children.filter(part => part.name === 'Chair rubber foot');
  assert.equal(feet.length, 4);
  for (const foot of feet) near(new Box3().setFromObject(foot).min.y, 0.012);
  assert.equal(chair.children.filter(part => part.name === 'Chair steel leg').length, 4);
  const bounds = new Box3().setFromObject(chair);
  assert.ok(bounds.max.y > 0.75 && bounds.max.y < 0.8);
  assert.ok(bounds.max.z - bounds.min.z < 0.4, 'chair must fit inside each 1.1m column');
  chair.traverse(node => { node.geometry?.dispose(); node.material?.dispose(); });
});

test('closed desk drawer stays below the existing tabletop and clear of the student chair', () => {
  const { Box3 } = require('three');
  const drawer = panelHarness().panel.createClassroomDeskDrawer();
  const bounds = new Box3().setFromObject(drawer);
  assert.ok(bounds.max.y < 0.69 && bounds.min.y > 0.58);
  assert.ok(bounds.min.z > -0.3 && bounds.max.z < 0.3);
  assert.ok(bounds.max.x < 0.24, 'drawer handle must clear the chair seat front');
  assert.equal(drawer.getObjectByName('Drawer wood front').geometry.type, 'RoundedBoxGeometry');
  assert.ok(drawer.getObjectByName('Drawer handle').material.metalness > 0.5);
  drawer.traverse(node => { node.geometry?.dispose(); node.material?.dispose(); });
});

test('lectern has textured-panel attachment, rounded edges and a sloped reading surface at the original height', () => {
  const { Box3 } = require('three');
  const lectern = panelHarness().panel.createClassroomLectern();
  const panels = lectern.getObjectByName('Lectern wood panels');
  assert.equal(panels.children.length, 5);
  assert.ok(panels.children.some(part => part.rotation.x < -0.2));
  lectern.traverse(node => {
    if (!node.isMesh) return;
    assert.equal(node.geometry.type, 'RoundedBoxGeometry');
    assert.ok(node.castShadow && node.receiveShadow);
    node.geometry.dispose();
    node.material.dispose();
  });
  const bounds = new Box3().setFromObject(lectern);
  assert.ok(bounds.max.y > 1.1 && bounds.max.y < 1.2);
});

test('classroom daylight has bounded shadows for small and large rooms and disposes shadow resources', () => {
  const { DirectionalLight } = require('three');
  for (const room of [{ width: 8.2, depth: 6.2, height: 3 }, { width: 30, depth: 25, height: 5 }]) {
    const panel = panelHarness().panel;
    const lights = panel.createClassroomLighting(room);
    const sun = lights.children.find(light => light instanceof DirectionalLight && light.castShadow);
    assert.equal(sun.shadow.mapSize.x, 2048);
    assert.ok(sun.shadow.camera.right > Math.hypot(room.width, room.depth) / 2);
    assert.ok(sun.shadow.camera.far > sun.position.length() + room.height);
    assert.ok(sun.shadow.normalBias > 0);
    let disposed = 0;
    sun.shadow.dispose = () => disposed++;
    panel.scene = new Group();
    panel.scene.add(lights);
    panel.presetInteriorRoot = lights;
    panel.disposePresetInterior();
    assert.equal(disposed, 1);
    assert.equal(panel.scene.children.length, 0);
  }
});

test('school props have small hanging backpacks and a hollow set square, marked ruler and compass', () => {
  const { Box3 } = require('three');
  const panel = panelHarness().panel;
  const bag = panel.createSchoolBackpack('#526c89');
  assert.equal(bag.children.filter(part => part.name === 'Backpack shoulder strap').length, 2);
  const bounds = new Box3().setFromObject(bag);
  assert.ok(bounds.min.x > -0.13 && bounds.max.x < 0.11);
  assert.ok(bounds.max.z - bounds.min.z < 0.25, 'backpack stays within the chair width');
  bag.position.set(0.4 + 0.245, 0.56, 0);
  const hanging = new Box3().setFromObject(bag);
  assert.ok(hanging.max.x < getClassroomDeskLayout().rowSpacing - 0.2, 'hanging backpack must not touch the next desk');
  assert.ok(hanging.min.y > 0.4, 'backpack must not sit on the floor');
  const tools = panel.createClassroomTeachingTools();
  const triangle = tools.getObjectByName('Teaching set square');
  assert.equal(triangle.geometry.type, 'ExtrudeGeometry');
  assert.equal(triangle.geometry.parameters.shapes.holes.length, 1);
  assert.ok(tools.getObjectByName('Teaching ruler'));
  assert.ok(tools.getObjectByName('Teaching compass'));
  assert.equal(tools.children.filter(part => part.geometry?.parameters.height === 0.003).length, 21);
  for (const prop of [bag, tools]) prop.traverse(node => {
    if (!node.isMesh) return;
    assert.ok(node.castShadow && node.receiveShadow);
    node.geometry.dispose();
    node.material.dispose();
  });
});

test('classroom outdoor ground spans at least 60 meters without covering the indoor floor', () => {
  const h = panelHarness();
  const { Box3 } = require('three');
  for (const room of [{ width: 8.2, depth: 6.2 }, { width: 30, depth: 25 }]) {
    const ground = h.panel.createClassroomGround(room);
    const bounds = new Box3().setFromObject(ground);
    assert.ok(bounds.max.x - bounds.min.x >= 60);
    assert.ok(bounds.max.z - bounds.min.z >= 60);
    const grass = ground.children.filter(node => node.name === 'Outdoor grass');
    assert.equal(grass.length, 4);
    let area = 0;
    for (const patch of grass) {
      const box = new Box3().setFromObject(patch);
      assert.ok(box.max.x <= -room.width / 2 + 1e-5 || box.min.x >= room.width / 2 - 1e-5
        || box.max.z <= -room.depth / 2 + 1e-5 || box.min.z >= room.depth / 2 - 1e-5);
      assert.ok(box.min.y > 0 && patch.receiveShadow);
      area += patch.geometry.parameters.width * patch.geometry.parameters.height;
    }
    near(area, (bounds.max.x - bounds.min.x) * (bounds.max.z - bounds.min.z) - room.width * room.depth);
    ground.traverse(node => {
      node.geometry?.dispose();
      node.material?.dispose();
    });
  }
});

test('parking lot has sixteen bays and an open six-meter lane, clear of other classroom scenery', () => {
  const h = panelHarness();
  const { Box3 } = require('three');
  for (const room of [{ width: 8.2, depth: 6.2 }, { width: 30, depth: 25 }]) {
    const parking = h.panel.createParkingLot(room);
    const bounds = new Box3().setFromObject(parking);
    const ground = h.panel.createClassroomGround(room);
    assert.ok(new Box3().setFromObject(ground).containsBox(new Box3(
      new Vector3(bounds.min.x, 0, bounds.min.z), new Vector3(bounds.max.x, 0, bounds.max.z))));
    assert.ok(bounds.max.x < -room.width / 2 - 1);
    const trees = h.panel.createClassroomTrees(room);
    const court = h.panel.createBasketballCourt(room);
    assert.equal(bounds.intersectsBox(new Box3().setFromObject(trees)), false);
    assert.equal(bounds.intersectsBox(new Box3().setFromObject(court)), false);
    const dividers = parking.children.filter(node => node.name === 'Parking bay divider');
    assert.equal(dividers.length, 18);
    for (const divider of dividers) {
      const local = new Box3().setFromObject(divider);
      assert.ok(local.max.x <= parking.position.x - 3 + 1e-6
        || local.min.x >= parking.position.x + 3 - 1e-6);
    }
    assert.equal(parking.children.filter(node => node.name === 'Parking wheel stop').length, 16);
    assert.equal(parking.children.filter(node => node.name === 'Parking lane direction').length, 2);
    const cars = parking.children.filter(node => node.name === 'Parked car');
    assert.equal(cars.length, 5);
    for (const car of cars) {
      const carBounds = new Box3().setFromObject(car);
      assert.ok(carBounds.max.x <= parking.position.x - 3 || carBounds.min.x >= parking.position.x + 3,
        'parked vehicles must leave the entire six-meter lane clear');
      assert.ok(carBounds.min.z >= car.position.z - 1.25 && carBounds.max.z <= car.position.z + 1.25,
        'cars must fit within individual parking bays');
      assert.ok(Math.abs(carBounds.min.y - 0.09) < 1e-6, 'tires must touch the asphalt surface');
      assert.equal(car.children.filter(node => node.name === 'Car tire').length, 4);
    }
    assert.equal(parking.children.filter(node => node.name === 'Parking lamp post').length, 4);
    assert.equal(parking.children.filter(node => node.name === 'Parking entry bollard').length, 4);
    assert.equal(parking.children.filter(node => node.name === 'Parking pedestrian crossing').length, 16);
    for (const group of [parking, ground, trees, court]) group.traverse(node => {
      node.geometry?.dispose();
      node.material?.dispose();
    });
  }
});

test('spectator stand has four ascending tiers, a clear central aisle and clearance from the court', () => {
  const h = panelHarness();
  const { Box3 } = require('three');
  for (const room of [{ width: 8.2, depth: 6.2 }, { width: 30, depth: 25 }]) {
    const stand = h.panel.createBleachers(room);
    const bounds = new Box3().setFromObject(stand);
    const ground = h.panel.createClassroomGround(room);
    const groundBounds = new Box3().setFromObject(ground);
    assert.ok(bounds.min.x >= groundBounds.min.x && bounds.max.x <= groundBounds.max.x);
    assert.ok(bounds.min.z >= groundBounds.min.z && bounds.max.z <= groundBounds.max.z);
    const court = h.panel.createBasketballCourt(room);
    assert.ok(bounds.min.z - new Box3().setFromObject(court).max.z >= 1.9);
    const tiers = stand.children.filter(node => node.name === 'Spectator tier');
    assert.equal(tiers.length, 8);
    tiers.forEach((tier, index) => near(tier.geometry.parameters.height, (Math.floor(index / 2) + 1) * 0.35));
    assert.equal(stand.children.filter(node => node.name === 'Central aisle step').length, 4);
    const benches = stand.children.filter(node => node.name === 'Spectator bench');
    assert.equal(benches.length, 8);
    for (const bench of benches) {
      assert.ok(Math.abs(bench.position.x) - bench.geometry.parameters.width / 2 >= 0.6);
    }
    const trees = h.panel.createClassroomTrees(room);
    const parking = h.panel.createParkingLot(room);
    for (const other of [trees, parking]) {
      assert.equal(bounds.intersectsBox(new Box3().setFromObject(other)), false);
    }
    for (const group of [stand, ground, court, trees, parking]) group.traverse(node => {
      node.geometry?.dispose();
      node.material?.dispose();
    });
  }
});

test('basketball court fits outside classroom and trees, within the outdoor ground, with two hoops', () => {
  const h = panelHarness();
  const { Box3 } = require('three');
  const room = { width: 8.2, depth: 6.2 };
  const court = h.panel.createBasketballCourt(room);
  const bounds = new Box3().setFromObject(court);
  assert.ok(bounds.min.x > room.width / 2 + 1);
  assert.ok(bounds.max.x < 30 && bounds.min.z > -30 && bounds.max.z < 30);
  assert.equal(court.children.filter(node => node.name === 'Basketball hoop').length, 2);
  assert.ok(court.children.filter(node => node.type === 'Line').length >= 10);
  const equipment = court.getObjectByName('Basketball sideline equipment');
  assert.equal(equipment.children.filter(node => node.name === 'Court sideline bench').length, 2);
  assert.equal(equipment.children.filter(node => node.name === 'Basketball training cone').length, 4);
  const cart = equipment.getObjectByName('Basketball ball cart');
  assert.equal(cart.children.filter(node => node.name === 'Basketball').length, 3);
  assert.ok(equipment.children.some(node => node.name === 'Basketball'));
  for (const prop of equipment.children) {
    const propBounds = new Box3().setFromObject(prop);
    assert.ok(propBounds.max.x < court.position.x - 7.5 || propBounds.min.x > court.position.x + 7.5,
      'all props must stay outside the fifteen-meter-wide playing area');
    assert.ok(propBounds.min.z >= -15 && propBounds.max.z <= 15, 'props must not extend towards the spectator aisle');
  }
  const trees = h.panel.createClassroomTrees(room);
  assert.equal(bounds.intersectsBox(new Box3().setFromObject(trees)), false);
  for (const group of [court, trees]) group.traverse(node => {
    node.geometry?.dispose();
    node.material?.dispose();
  });
});

test('classroom trees stay outside both window walls and fit on the existing ground', () => {
  const h = panelHarness();
  const { Box3 } = require('three');
  const room = { width: 8.2, depth: 6.2 };
  const trees = h.panel.createClassroomTrees(room);
  assert.equal(trees.children.length, 6);
  for (const tree of trees.children) {
    const bounds = new Box3().setFromObject(tree);
    assert.ok(bounds.min.z > room.depth / 2 + 1 || bounds.max.z < -room.depth / 2 - 1,
      'trunks and crowns must stay clear of the classroom walls and windows');
    assert.ok(bounds.min.x > -10 && bounds.max.x < 10 && bounds.min.z > -10 && bounds.max.z < 10);
    assert.ok(bounds.min.y >= -1e-6 && bounds.max.y >= 3 && bounds.max.y <= 4);
    assert.equal(tree.children.length, 4);
  }
  trees.traverse(node => {
    node.geometry?.dispose();
    node.material?.dispose();
  });
});

test('the actual panel render loop follows live Roll/Pitch/Yaw, holds stale orientation and returns to simulation', () => {
  const h = panelHarness();
  h.panel.attitudeActive = true;
  h.panel.attitudeReception.receive({ ...sample(50, 70), roll: 30, pitch: 20 }, 0);
  h.render(6);
  assert.ok(h.panel.droneGroup.quaternion.angleTo(attitudeQuaternion(30, 20, 70, Math.PI)) < 5 * Math.PI / 180,
    'render smoothing must approach the target within 5 degrees after about 100 ms');
  h.render(34);
  near(h.panel.droneGroup.quaternion.angleTo(attitudeQuaternion(30, 20, 70, Math.PI)), 0);
  near(h.panel.flightAxes.quaternion.angleTo(attitudeQuaternion(30, 20, 70)), 0);
  const pose = h.panel.droneGroup.position.clone();
  h.render(40);
  assert.equal(h.panel.attitudeMetrics.stale, true);
  near(h.panel.droneGroup.quaternion.angleTo(attitudeQuaternion(30, 20, 70, Math.PI)), 0);
  vectorNear(h.panel.droneGroup.position, pose.toArray());
  h.panel.attitudeActive = false;
  h.sim.pose$.value.yaw = Math.PI / 2;
  h.render(40);
  near(h.panel.droneGroup.quaternion.angleTo(attitudeQuaternion(0, 0, 90, Math.PI)), 0);
  assert.ok(h.rendered >= 100);
});

test('panel monitoring is opt-in, reports missing bridge/start errors and disposes listeners on stop', async () => {
  const h = panelHarness();
  assert.equal(h.panel.attitudeActive, false);
  helperContext.window.electronAPI = undefined;
  await h.panel.toggleAttitude();
  assert.ok(h.messages[0].includes('重启应用'));
  let listener;
  let removed = 0;
  let stops = 0;
  helperContext.window.electronAPI = { crazyflie: {
    startAttitude: async () => ({ success: true }),
    stopAttitude: async () => { stops++; listener({ type: 'stopped' }); return { success: true }; },
    onAttitude: callback => { listener = callback; return () => removed++; },
  } };
  await h.panel.toggleAttitude();
  assert.equal(h.panel.attitudeActive, true);
  listener({ ...sample(10, 30), roll: 12, pitch: 4 });
  assert.equal(h.panel.attitudeReception.sample.roll, 12);
  await h.panel.toggleAttitude();
  assert.equal(stops, 1);
  assert.equal(removed, 1);
  assert.equal(h.panel.attitudeActive, false);
  helperContext.window.electronAPI.crazyflie.startAttitude = async () => ({ success: false, message: 'radio busy' });
  await h.panel.toggleAttitude();
  assert.equal(h.panel.attitudeActive, false);
  assert.equal(h.messages.at(-1), 'radio busy');
  assert.equal(removed, 2);
  delete helperContext.window.electronAPI;
});

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

function panelHarness() {
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
      if (name === 'three' || name === 'rxjs') return require(name);
      if (name.endsWith('/crazyflie-attitude')) return helper.exports;
      if (name.endsWith('/GLTFLoader.js')) return { GLTFLoader: class {} };
      if (name.endsWith('/ColladaLoader.js')) return { ColladaLoader: class {} };
      if (name.endsWith('/OrbitControls.js')) return {};
      return {};
    },
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

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
const generatorDir = path.join(root, 'src', 'app', 'editors', 'blockly-editor', 'components',
  'blockly', 'generators', 'crazyflie');
function loadGenerator(name) {
  const exports = {};
  vm.runInNewContext(ts.transpileModule(fs.readFileSync(path.join(generatorDir, name), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText, { exports, require });
  return exports;
}
const examples = loadGenerator('examples.ts');
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
cancel_takeoff = [False]
fail_during_flight = [False]
stop_requested = Event()
reset_callbacks = []
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
                    'stabilizer.pitch': -10, 'stabilizer.yaw': 30,
                    'stateEstimate.x': 1, 'stateEstimate.y': 2, 'stateEstimate.z': 3}, self)
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
            param=types.SimpleNamespace(
                add_update_callback=lambda **kwargs: reset_callbacks.append(kwargs['cb']),
                remove_update_callback=lambda **kwargs: reset_callbacks.remove(kwargs['cb'])),
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
    def take_off(self, **kwargs):
        commands.append('takeoff')
        if cancel_takeoff[0]: stop_requested.set()
        if fail_during_flight[0]:
            configurations[-1].error_cb.call(configurations[-1], 'lost XYZ during flight')
            time.sleep(0.1)
    def stop(self): commands.append('hover')
    def land(self, **kwargs): commands.append('land')
modules['cflib.crtp'].init_drivers = lambda **kwargs: None
modules['cflib.crazyflie.syncCrazyflie'].SyncCrazyflie = Connection
modules['cflib.crazyflie.log'].LogConfig = Config
modules['cflib.crazyflie.syncLogger'].SyncLogger = object
modules['cflib.positioning.motion_commander'].MotionCommander = Commander
modules['cflib.crtp.radiodriver'].RadioDriver = lambda: types.SimpleNamespace(get_status=lambda: 'mock radio')
runner._radio_status = lambda uri: 'mock radio'
modules['cflib.utils.multiranger'].Multiranger = object
idle = runner.parse_commands('cf_crazyflie_link()\\ncf_delay(0.2)\\ncf_print("done")')
out = io.StringIO()
with redirect_stdout(out):
    result = runner.run_flow('radio://mock', idle, 'E7E7E7E7E7', attitude=True)
assert result['success'], result
assert len(connections) == 1 and not commands, 'monitoring must not arm or move motors'
samples = [json.loads(line.split(':', 1)[1]) for line in out.getvalue().splitlines()
           if line.startswith('__ATTITUDE__:')]
assert len([s for s in samples if s['type'] == 'sample']) >= 2, samples
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
for fault in ['none', 'preflight', 'cancel', 'inflight']:
    bad_logger[0] = fault == 'preflight'
    cancel_takeoff[0] = fault == 'cancel'
    fail_during_flight[0] = fault == 'inflight'
    stop_requested.clear()
    connections.clear()
    configurations.clear()
    commands.clear()
    with redirect_stdout(io.StringIO()):
        result = runner.run_flow('radio://mock', flight, 'E7E7E7E7E7',
                                 follow_position=True, stop_requested=stop_requested)
    assert result['success'] == (fault == 'none'), (fault, result)
    assert len(connections) == 1 and active[0] == 0
    assert not reset_callbacks, fault
    if fault == 'preflight':
        assert not commands, 'missing telemetry must fail before arming or starting motors'
    else:
        assert commands[-1] == 'land', (fault, commands)
    if fault in ('cancel', 'inflight'):
        assert commands == ['arm', 'takeoff', 'land'], (fault, commands)
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

test('Electron retains one real connection across button, blocks and flights with stable radio identity', async () => {
  const filename = path.join(root, 'electron', 'crazyflie.js');
  const handlers = new Map();
  let startCount = 0, stopCount = 0, cancellations = 0;
  let config;
  let finishFlow;
  let active = false;
  let spawnFailure = false, deferEnumeration = false;
  let enumerationCallback;
  let radios = [{ index: 0, serial: 'AABBCCDD0001' }, { index: 1, serial: 'AABBCCDD0002' }];
  let prefixChild, prefixArgs;
  const messages = [];
  const exports = {};
  const context = {
    exports, module: { exports }, process: { env: {} }, __dirname: path.dirname(filename),
    require: name => name === 'electron' ? { ipcMain: { handle: (key, fn) => handlers.set(key, fn) } }
      : name === './crazyflie-session' ? { startCrazyflieSession: options => {
        if (spawnFailure) throw new Error('mock process launch failed');
        startCount++;
        config = options;
        const ready = Promise.resolve().then(() => {
          options.onEvent({ type: 'state', state: 'ready' });
          options.onEvent({ type: 'attitude', payload: { type: 'sample', timestampMs: 25, roll: 5, pitch: 10, yaw: 15 } });
          return { success: true };
        });
        return {
          ready, get running() { return active; },
          request: async (action, opts) => {
            if (action === 'observe') return { success: true };
            assert.equal(action, 'run');
            assert.ok(opts.code.includes('cf_motion'), opts.code);
            active = true;
            options.onEvent({ type: 'state', state: 'flow' });
            options.onEvent({ type: 'telemetry', payload: { batteryVolts: 4, batteryPercent: 75, linkQuality: 93 } });
            options.onEvent({ type: 'log', line: '__ATTITUDE__:{"type":"sample","timestampMs":50,"roll":0,"pitch":0,"yaw":0,"x":1,"y":2,"z":3}' });
            options.onEvent({ type: 'log', line: '__STEP__:1/2:motion:takeoff' });
            const result = await new Promise(resolve => { finishFlow = resolve; });
            active = false;
            options.onEvent({ type: 'state', state: 'ready' });
            return result;
          },
          cancel: () => { cancellations++; },
          stop: async () => {
            stopCount++;
            options.onEvent({ type: 'state', state: 'disconnected' });
            options.onClose();
          },
        };
      } } : name === 'child_process' ? {
        spawn: (_python, args) => {
          prefixArgs = args;
          prefixChild = new EventEmitter();
          prefixChild.stdin = new PassThrough();
          prefixChild.stdout = new PassThrough();
          prefixChild.stderr = new PassThrough();
          prefixChild.kill = () => prefixChild.emit('close', 1);
          return prefixChild;
        },
        execFile: (_python, _args, _options, callback) => {
          assert.ok(_args.includes('--list-radios'));
          if (deferEnumeration) enumerationCallback = callback;
          else callback(null, JSON.stringify({ success: true, radios }), '');
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
  const opts = { uri: 'radio://1/80/2M', addressHex: 'E7E7E7E7E7', explicitRadio: true };
  assert.equal((await handlers.get('crazyflie-connect')(event, { ...opts, uri: 'invalid' })).success, false);
  assert.equal((await handlers.get('crazyflie-connect')(event, { uri: 'radio://0/80/2M' })).success, false,
    'multiple USB devices require a deliberate selection');
  const connected = await handlers.get('crazyflie-connect')(event, opts);
  assert.equal(connected.success, true);
  assert.equal(connected.radioSerial, 'AABBCCDD0002');
  assert.equal(connected.uri, 'radio://AABBCCDD0002/80/2M/E7E7E7E7E7');
  assert.ok(config.connectionArgs.includes(connected.uri));
  assert.ok(messages.some(item => item.channel === 'crazyflie-attitude' && item.payload.source === 'idle'),
    'connecting automatically streams idle attitude without another request');
  assert.equal((await handlers.get('crazyflie-connect')(event, opts)).success, true);
  assert.equal(startCount, 1, 'repeated connections reuse the same Python connection');
  assert.equal((await handlers.get('crazyflie-connect')(event, { ...opts, radioId: 'AABBCCDD0001' })).success, false,
    'a header selection must not silently override an explicit block device');
  assert.equal((await handlers.get('crazyflie-connect')(event, { ...opts, uri: 'radio://0/80/2M' })).success, false);
  assert.equal((await handlers.get('crazyflie-run-flow')({ sender: { id: 2 } }, {})).radioStatus, 'busy');
  assert.equal((await handlers.get('crazyflie-stop-attitude')({ sender: { id: 2 } })).success, false);
  assert.equal(stopCount, 0);
  const code = 'cf_motion("takeoff", [0.5, 0.2])\ncf_motion("land", [0.2])';
  const flow = handlers.get('crazyflie-run-flow')(event, { ...opts, code, followPosition: true });
  assert.equal((await handlers.get('crazyflie-test-link')(event, opts)).radioStatus, 'busy');
  await tick();
  await tick();
  assert.equal((await handlers.get('crazyflie-disconnect')(event)).success, false, 'do not disconnect during flight');
  assert.equal(handlers.get('crazyflie-cancel-flow')({ sender: { id: 2 } }).success, false);
  assert.equal(handlers.get('crazyflie-cancel-flow')(event).success, true);
  assert.equal(cancellations, 1);
  finishFlow({ success: false, message: 'Flight cancelled', executed: [] });
  assert.equal((await flow).success, false);
  assert.equal(messages.filter(item => item.channel === 'crazyflie-attitude' && item.payload.type === 'sample'
    && item.payload.source === 'flow').length, 1);
  assert.equal(messages.filter(item => item.channel === 'crazyflie-flow-log').length, 1);
  assert.ok(messages.some(item => item.channel === 'crazyflie-telemetry' && item.payload.linkQuality === 93));
  assert.equal(startCount, 1, 'a flow must not replace the connection');
  assert.equal(handlers.get('crazyflie-connection-state')(event).status, 'ready');
  assert.equal((await handlers.get('crazyflie-test-link')(event, opts)).success, true);
  assert.equal((await handlers.get('crazyflie-start-attitude')(event, opts)).success, true);
  assert.equal((await handlers.get('crazyflie-stop-attitude')(event)).success, true);
  assert.equal(stopCount, 0, 'turning attitude display off leaves the connection open');
  assert.equal((await handlers.get('crazyflie-disconnect')(event)).success, true);
  assert.equal(stopCount, 1);
  const automatic = handlers.get('crazyflie-run-flow')(event, { ...opts, code });
  await tick();
  await tick();
  assert.equal(startCount, 2, 'a disconnected flight automatically connects without a connection block');
  finishFlow({ success: true, executed: [] });
  assert.equal((await automatic).success, true);
  sender.emit('did-start-navigation', null, 'url', false, true);
  await tick();
  assert.equal(stopCount, 2);
  radios = [{ index: 0, serial: 'AABBCCDD0002' }, { index: 1, serial: 'AABBCCDD0001' }];
  const stable = { uri: connected.uri, radioId: connected.radioSerial };
  const reordered = await handlers.get('crazyflie-connect')(event, stable);
  assert.equal(reordered.radioIndex, 0);
  assert.equal(reordered.radioSerial, connected.radioSerial, 'USB order changes must not change the selected hardware');
  await handlers.get('crazyflie-disconnect')(event);
  radios = [radios[1]];
  assert.equal((await handlers.get('crazyflie-connect')(event, stable)).success, false, 'unplugged device cannot fall back to another one');
  radios = [{ index: 0, serial: 'AABBCCDD0001' }, { index: 1, serial: 'AABBCCDD0002' }];
  const before = startCount;
  deferEnumeration = true;
  const abandoned = handlers.get('crazyflie-run-flow')(event, { ...opts, code });
  sender.emit('did-start-navigation', null, 'url', false, true);
  enumerationCallback(null, JSON.stringify({ success: true, radios }), '');
  assert.equal((await abandoned).success, false);
  assert.equal(startCount, before, 'leaving during enumeration must not open a new radio');
  deferEnumeration = false;
  spawnFailure = true;
  assert.equal((await handlers.get('crazyflie-connect')(event, opts)).success, false);
  assert.equal(handlers.get('crazyflie-connection-state')(event).status, 'disconnected');
  assert.equal(sender.listenerCount('destroyed'), 0, 'failed startup must remove owner and operation listeners');
  spawnFailure = false;
  const scanned = handlers.get('crazyflie-run-flow')(event, { ...opts,
    code: 'cf_set_link("radio://1/80/2M", "E7E7E7E7E7")\ncf_scan_links("E7E7E7E7E7")\n' + code });
  assert.equal(startCount, before, 'scanning must finish before the persistent connection opens');
  const prefixCode = Buffer.from(prefixArgs[prefixArgs.indexOf('--code-base64') + 1], 'base64').toString();
  assert.match(prefixCode, /cf_scan_links/);
  assert.doesNotMatch(prefixCode, /cf_motion/);
  prefixChild.stdout.write('__STEP__:2/2:scan_links\n{"success":true,"executed":["set_link","scan_links"]}\n');
  prefixChild.emit('close', 0);
  await tick();
  await tick();
  finishFlow({ success: true, executed: ['takeoff', 'land'] });
  assert.deepEqual(Array.from((await scanned).executed), ['set_link', 'scan_links', 'takeoff', 'land']);
  assert.ok(messages.some(item => item.channel === 'crazyflie-flow-log' && item.payload.line === '__STEP__:3/4:motion:takeoff'));
  await handlers.get('crazyflie-disconnect')(event);
  assert.equal(sender.listenerCount('destroyed'), 0);
  assert.equal(sender.listenerCount('destroyed'), 0);
});

test('classroom uses natural wood finishes without loose books or extra cabinets', () => {
  const filename = path.join(root, 'src', 'app', 'editors', 'blockly-editor', 'components', 'blockly',
    'components', 'crazyflie-sim-panel', 'crazyflie-sim-panel.component.ts');
  const source = fs.readFileSync(filename, 'utf8');
  assert.match(source, /createLightClassroomTexture\(woodMaterial\.map, '#ffffff', 0\)/);
  assert.match(source, /createLightClassroomTexture\(map, '#dfb270', 0\.42\)/);
  assert.match(source, /this\.applyVarnishedPineFinish\(teachingStage\)/);
  assert.match(source, /this\.applyVarnishedPineFinish\(doorGroup\)/);
  assert.match(source, /this\.applyVarnishedPineFinish\(lecternPanels, 'lectern'\)/);
  assert.match(source, /this\.applyVarnishedPineFinish\(floor, 'floor'\)/);
  assert.match(source, /this\.loadVarnishedPineMaterial\('desk'\)/);
  assert.match(source, /\[this\.createClassroomChair\(\), chairOffsetX, 'chair'\]/);
  assert.match(source, /\[this\.createClassroomDeskDrawer\(\), 0, 'desk'\]/);
  assert.match(source, /this\.applyVarnishedPineFinish\(instances, finish\)/);
  assert.doesNotMatch(source, /applyVarnishedPineFinish\(podiumGroup\)/);
  assert.doesNotMatch(source, /loadClassroomProtoAsset\('school_furniture\/protos\/Book\.proto'\)/);
  assert.doesNotMatch(source, /Webots school book|cabinetGroup|lowShelfGroup/);
});

function panelHarness({ globals = {}, three = require('three'), modules = {} } = {}) {
  const filename = path.join(root, 'src', 'app', 'editors', 'blockly-editor', 'components', 'blockly',
    'components', 'crazyflie-sim-panel', 'crazyflie-sim-panel.component.ts');
  const js = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, experimentalDecorators: true },
  }).outputText;
  let now = 0;
  let frame;
  const exports = {};
  const context = {
    exports, performance: { now: () => now }, queueMicrotask, window: { devicePixelRatio: 1 },
    requestAnimationFrame: callback => { frame = callback; return 1; }, cancelAnimationFrame() {},
    require: name => {
      if (modules[name]) return modules[name];
      if (name === '@angular/core') return { Component: () => target => target, ViewChild: () => () => {} };
      if (name === '@angular/common') return {};
      if (name === 'three') return three;
      if (name === 'blockly') return require(name);
      if (name.endsWith('/crazyflie/examples')) return examples;
      if (name === 'rxjs') return require(name);
      if (name.endsWith('/crazyflie-attitude')) return helper.exports;
      if (name.endsWith('/crazyflie-classroom')) return classroom.exports;
      if (name.endsWith('/crazyflie-exploration') || name.endsWith('/crazyflie-geography')) {
        return require('./helpers/load-crazyflie-data.cjs')(path.join(root, 'src', 'app', 'services', `${name.split('/').at(-1)}.ts`));
      }
      if (name.endsWith('/GLTFLoader.js')) return { GLTFLoader: class {} };
      if (name.endsWith('/ColladaLoader.js')) return { ColladaLoader: class {} };
      if (name.endsWith('/RoundedBoxGeometry.js')) return require(name);
      if (name.endsWith('/BufferGeometryUtils.js')) return require(name);
      if (name.endsWith('/OrbitControls.js')) return {};
      return {};
    },
    ...globals,
  };
  vm.runInNewContext(js, context);
  const messages = [];
  const sim = {
    pose$: { value: { x: 0, y: 0, z: 0, yaw: 0 } },
    poseSource$: { value: 'simulation' }, realAttitude$: { value: null },
    roomPreset$: { value: 'classroom' },
  };
  const { BehaviorSubject } = require('rxjs');
  const connection = { state$: new BehaviorSubject({ status: 'disconnected' }),
    attitude$: new BehaviorSubject(null), attitudeError$: new BehaviorSubject(null),
    attitudeReception: new AttitudeReception() };
  const panel = new exports.CrazyflieSimPanelComponent(sim, connection, {},
    { error: text => messages.push(text), warning: text => messages.push(text) },
    { run: fn => fn() }, { instant: key => key });
  panel.scene = {};
  panel.camera = {};
  let rendered = 0;
  panel.renderer = { getPixelRatio: () => 1, render() { rendered++; } };
  panel.droneGroup = new Group();
  panel.droneGroup.rotation.y = Math.PI;
  panel.droneGroup.position.copy(panel.targetPosition);
  panel.flightAxes = new Group();
  return {
    panel, messages, sim, connection,
    render(count) {
      if (!frame) panel.startRenderLoop();
      for (let i = 0; i < count; i++) { now += 1000 / 60; frame(); }
    },
    get rendered() { return rendered; },
  };
}

test('geography initializes and resets to a north-up top view while other scenes keep their isometric view', () => {
  const THREE = require('three');
  const { panel, sim } = panelHarness();
  panel.camera = new THREE.PerspectiveCamera();
  panel.controls = { target: new THREE.Vector3(), update() {}, enableDamping: true };
  let fits = 0;
  panel.setupSubscriptions = () => {};
  panel.fitCameraToScene = () => { fits++; };
  for (const preset of ['china', 'world', 'animals', 'home', 'classroom']) {
    sim.roomPreset$.value = preset;
    panel.ngOnInit();
    assert.equal(panel.selectedView, ['china', 'world'].includes(preset) ? 'top' : 'iso');
    panel.selectedView = '';
    panel.resetCameraView();
    assert.equal(panel.selectedView, ['china', 'world'].includes(preset) ? 'top' : 'iso');
    if (['china', 'world'].includes(preset)) {
      near(panel.camera.position.x, 0);
      near(panel.camera.position.y, 20);
      near(panel.controls.target.length(), 0);
    }
  }
  assert.equal(fits, 4);
});

test('exploration camera fit keeps all floor and exhibit bounds visible in narrow and wide viewports', () => {
  const THREE = require('three');
  for (const aspect of [0.55, 1, 1.8]) {
    const { panel } = panelHarness();
    panel.camera = new THREE.PerspectiveCamera(58, aspect, 0.005, 100);
    panel.camera.position.set(5.2, 4, -3.2);
    panel.controls = { target: new THREE.Vector3(0, 0.8, 0), update() {}, enabled: true };
    const bounds = new THREE.Box3(new THREE.Vector3(-4, -0.2, -4), new THREE.Vector3(4, 3, 4));
    panel.frameCameraBounds(bounds, 0, true);
    panel.camera.lookAt(panel.controls.target);
    panel.camera.updateMatrixWorld(true);
    for (const x of [-4, 4]) for (const y of [-0.2, 3]) for (const z of [-4, 4]) {
      const screen = new THREE.Vector3(x, y, z).project(panel.camera);
      assert.ok(Math.abs(screen.x) <= 1 && Math.abs(screen.y) <= 1, `${aspect}: ${screen.toArray()}`);
      assert.ok(screen.z >= -1 && screen.z <= 1);
    }
  }
});

test('checkpoint selection provides simulation-only body guidance without moving the aircraft and hides completed guides', () => {
  const calls = [];
  const { panel, sim } = panelHarness({ modules: {
    '../../../../../../services/crazyflie-exploration-scene': {
      updateExplorationMarkers: (...args) => calls.push(['markers', ...args]),
      updateExplorationGuide: (...args) => calls.push(['guide', ...args]),
    },
  } });
  panel.runtime = { policy$: { value: 'sim-only' } };
  sim.roomPreset$.value = 'animals';
  sim.explorationProgress$ = { value: { visited: [], dwelling: null, dwellPercent: 0 } };
  sim.pose$.value = { x: 0, y: 0.06, z: 0, yaw: 0 };
  panel.presetInteriorRoot = new Group();
  panel.presetInteriorRoot.userData.exploration = true;
  panel.camera = null;
  const point = panel.explorationScene.points[0], original = { ...sim.pose$.value };
  panel.focusCheckpoint(point);
  assert.equal(panel.selectedCheckpointId, point.id);
  assert.deepEqual(sim.pose$.value, original);
  const moves = JSON.parse(JSON.stringify(panel.checkpointGuidance.moves));
  assert.deepEqual(moves.map(move => move.key), ['FORWARD', 'RIGHT', 'UP']);
  for (const [index, meters] of [1.2, 1.2, 0.6].entries()) assert.ok(Math.abs(moves[index].meters - meters) < 1e-8);
  sim.pose$.value.yaw = Math.PI;
  assert.equal(panel.checkpointGuidance.moves[0].key, 'BACK');
  sim.explorationProgress$.value.visited = [point.id];
  panel.updateExplorationMarkers();
  assert.equal(calls.at(-1)[3], undefined, 'completed targets must not retain an active guide line');
  for (const mode of ['sim-real', 'real-only']) {
    panel.runtime.policy$.value = mode;
    assert.equal(panel.checkpointGuidance, null);
    panel.updateExplorationMarkers();
    assert.equal(calls.at(-1)[4], false);
  }
  panel.runtime.policy$.value = 'sim-only';
  sim.poseSource$.value = 'real';
  assert.equal(panel.checkpointGuidance, null);
  sim.poseSource$.value = 'simulation';
  panel.clearCheckpointSelection();
  assert.equal(panel.selectedCheckpointId, null);
  assert.equal(panel.checkpointGuidance, null);
});

test('closing a themed scene releases the complete exploration root including navigation graphics', () => {
  let disposed = 0;
  const { panel } = panelHarness({ modules: {
    '../../../../../../services/crazyflie-exploration-scene': { disposeExplorationScene: () => { disposed++; } },
  } });
  panel.scene = new (require('three').Scene)();
  panel.presetInteriorRoot = new Group();
  panel.presetInteriorRoot.userData.exploration = true;
  panel.scene.add(panel.presetInteriorRoot);
  panel.renderer = null;
  panel.ngOnDestroy();
  assert.equal(disposed, 1);
  assert.equal(panel.presetInteriorRoot, null);
  assert.equal(panel.scene.children.length, 0);
});

test('the furnished apartment replaces the legacy room, fits on reset and releases its owned scene on close', () => {
  const THREE = require('three');
  let built = 0, disposed = 0, fitted = 0;
  const apartment = new THREE.Group();
  apartment.userData.home = true;
  const { panel, sim } = panelHarness({ modules: {
    '../../../../../../services/crazyflie-home-scene': { createHomeScene: () => { built++; return apartment; } },
    '../../../../../../services/crazyflie-exploration-scene': { disposeExplorationScene: root => {
      assert.equal(root, apartment);
      disposed++;
    } },
  } });
  panel.scene = new THREE.Scene();
  panel.floorMesh = { visible: true };
  panel.roomWireframe = { visible: false };
  panel.rebuildPresetInterior('custom', { width: 14, depth: 12, height: 3.2 });
  assert.equal(panel.roomWireframe.visible, true);
  sim.roomPreset$.value = 'home';
  panel.rebuildPresetInterior('home', { width: 14, depth: 12, height: 3.2 });
  assert.equal(built, 1);
  assert.equal(panel.presetInteriorRoot, apartment);
  assert.equal(panel.floorMesh.visible, false);
  assert.equal(panel.roomWireframe.visible, false);
  panel.camera = new THREE.PerspectiveCamera();
  panel.fitCameraToScene = () => { fitted++; };
  panel.resetCameraView();
  assert.equal(fitted, 1, 'reset and initial home selection must frame the whole apartment');
  panel.renderer = null;
  panel.ngOnDestroy();
  assert.equal(disposed, 1);
  assert.equal(panel.presetInteriorRoot, null);
});

test('classroom palettes cache distinct light finishes, share detail maps and retry failed variants', async () => {
  const THREE = require('three');
  let fetches = 0;
  const requests = [];
  const transforms = [];
  const panel = panelHarness({
    globals: {
      URL, window: { location: { href: 'http://localhost/' } },
      fetch: async () => {
        fetches++;
        return { ok: true, text: async () => fs.readFileSync(path.join(root, 'public', 'models', 'classroom',
          'appearances', 'protos', 'VarnishedPine.proto'), 'utf8') };
      },
    },
    three: { ...THREE, TextureLoader: class {
      async loadAsync(url) { requests.push(url); return new THREE.Texture({}); }
    } },
  }).panel;
  panel.createLightClassroomTexture = (source, tint, opacity) => {
    transforms.push({ source, tint, opacity });
    return new THREE.CanvasTexture({});
  };
  const pending = panel.loadVarnishedPineMaterial('floor');
  assert.equal(panel.loadVarnishedPineMaterial('floor'), pending);
  const [floor, desk, chair, honey] = await Promise.all([
    pending, panel.loadVarnishedPineMaterial('desk'),
    panel.loadVarnishedPineMaterial('chair'), panel.loadVarnishedPineMaterial(),
  ]);
  assert.equal(fetches, 1, 'all colors use one underlying pine asset request');
  assert.equal(requests.length, 4, 'normal, roughness and AO maps must not be reloaded for every palette');
  for (const [material, tint, opacity, roughness] of [
    [floor, '#d4c2aa', 0.72, 0.88], [desk, '#efd0a0', 0.32, 0.74], [chair, '#b7c9bd', 0.82, 0.82],
  ]) {
    const transform = transforms.find(item => item.tint === tint);
    assert.equal(transform.source, honey.map);
    assert.equal(transform.opacity, opacity);
    assert.notEqual(material.map, honey.map);
    assert.equal(material.roughnessMap, honey.roughnessMap);
    assert.equal(material.normalMap, honey.normalMap);
    assert.equal(material.aoMap, honey.aoMap);
    assert.equal(material.color.getHexString(), 'ffffff');
    assert.equal(material.roughness, roughness);
    assert.deepEqual(material.map.repeat.toArray(), [3, 3]);
  }
  assert.equal(honey.roughness, 0.7, 'stage, door and lectern must retain their honey finish');
  const lectern = await panel.loadVarnishedPineMaterial('lectern');
  assert.equal(lectern.isMeshPhysicalMaterial, true);
  assert.equal(lectern.map, honey.map, 'lectern varnish cannot change its honey color or duplicate its map');
  assert.equal(lectern.roughnessMap, honey.roughnessMap);
  assert.equal(desk.isMeshPhysicalMaterial, true);
  assert.equal(chair.isMeshPhysicalMaterial, true);
  assert.equal(floor.isMeshPhysicalMaterial, undefined, 'floor must remain matte and unreflected');
  assert.equal(desk.envMapIntensity, 0.1);
  assert.equal(transforms.length, 4);
  assert.equal(new Set([floor.map, desk.map, chair.map, honey.map]).size, 4);
  panel.classroomWoodMaterialPromises.delete('floor');
  const transform = panel.createLightClassroomTexture;
  panel.createLightClassroomTexture = () => { throw new Error('test canvas allocation failed'); };
  await assert.rejects(panel.loadVarnishedPineMaterial('floor'), /test canvas allocation failed/);
  assert.equal(panel.classroomWoodMaterialPromises.has('floor'), false);
  panel.createLightClassroomTexture = transform;
  const retried = await panel.loadVarnishedPineMaterial('floor');
  assert.notEqual(retried, floor);
  assert.equal(requests.length, 4, 'retrying a tint cannot refetch the shared asset');
  for (const material of [floor, desk, chair, honey, retried]) {
    material.map.dispose();
    material.dispose();
  }
  honey.normalMap.dispose();
  honey.roughnessMap.dispose();
  honey.aoMap.dispose();
  lectern.dispose();
});

test('floor uses its light neutral finish, preserves its grain and never disposes shared textures', async () => {
  const THREE = require('three');
  for (const replaceScene of [false, true]) {
    const map = new THREE.CanvasTexture({});
    map.colorSpace = THREE.SRGBColorSpace;
    const roughnessMap = new THREE.Texture({});
    const normalMap = new THREE.Texture({});
    const aoMap = new THREE.Texture({});
    const textures = [map, roughnessMap, normalMap, aoMap];
    let disposedTextures = 0;
    textures.forEach(texture => {
      texture.repeat.set(3, 3);
      texture.addEventListener('dispose', () => disposedTextures++);
    });
    const template = new THREE.MeshStandardMaterial({
      color: '#ffffff', map, roughnessMap, normalMap, aoMap,
      roughness: 0.88, metalness: 0, normalScale: new THREE.Vector2(0.3, 0.3), aoMapIntensity: 0.35,
    });
    const panel = panelHarness().panel;
    let finishLoad;
    panel.loadVarnishedPineMaterial = finish => {
      assert.equal(finish, 'floor');
      return new Promise(resolve => { finishLoad = resolve; });
    };
    const group = new THREE.Group();
    panel.scene = new THREE.Scene();
    panel.scene.add(group);
    panel.presetInteriorRoot = group;
    panel.createClassroomWoodFloor(group, { width: 8, depth: 6 });
    const floor = group.getObjectByName('Webots pine classroom floor');
    const fallback = floor.material;
    let disposedGeometry = 0;
    let disposedFallback = 0;
    floor.geometry.addEventListener('dispose', () => disposedGeometry++);
    fallback.addEventListener('dispose', () => disposedFallback++);
    assert.equal(floor.material.isMeshStandardMaterial, true);
    assert.equal(floor.material.roughness, 0.88);
    assert.equal(floor.material.metalness, 0);
    assert.equal(floor.receiveShadow, true);
    assert.ok(floor.geometry.getAttribute('uv2'));
    assert.equal(floor.material.color.getHexString(), 'd4c2aa');
    if (replaceScene) panel.disposePresetInterior();
    finishLoad(template);
    await new Promise(setImmediate);
    assert.equal(disposedFallback, 1);
    if (replaceScene) {
      assert.equal(floor.material.map, null, 'a late texture cannot revive a disposed scene');
      assert.equal(floor.material, fallback);
    } else {
      assert.notEqual(floor.material, template, 'the floor has its own material instance');
      assert.notEqual(floor.material, fallback);
      assert.equal(floor.material.map, map, 'the floor uses its cached light wood finish');
      assert.equal(floor.material.roughnessMap, roughnessMap);
      assert.equal(floor.material.normalMap, normalMap);
      assert.equal(floor.material.aoMap, aoMap);
      assert.equal(floor.material.aoMapIntensity, template.aoMapIntensity);
      assert.deepEqual(floor.material.normalScale.toArray(), [0.3, 0.3]);
      assert.deepEqual(map.repeat.toArray(), [3, 3], 'the visible pine grain is not washed out or rescaled');
      assert.equal(floor.material.color.getHexString(), 'ffffff');
      assert.equal(floor.material.roughness, template.roughness);
      assert.equal(floor.userData.sharedClassroomTextures, true);
      panel.disposePresetInterior();
    }
    assert.equal(disposedGeometry, 1);
    assert.equal(disposedTextures, 0, 'removing the floor cannot invalidate the stage or door textures');
    template.dispose();
    textures.forEach(texture => texture.dispose());
  }
});

test('imported desk faces upward and uses its warm finish without recoloring the metal frame', async () => {
  const THREE = require('three');
  const woodPixels = new Uint8ClampedArray([223, 178, 112, 255, 223, 178, 112, 255]);
  const maskPixels = new Uint8ClampedArray([0, 0, 0, 255, 255, 255, 255, 255]);
  let outputPixels;
  const canvas = {
    width: 2, height: 1,
    getContext: () => ({
      putImageData(image) { outputPixels = image.data; },
      getImageData: () => ({ data: woodPixels.slice() }),
    }),
  };
  const woodMap = new THREE.CanvasTexture(canvas);
  const woodMaterial = new THREE.MeshStandardMaterial({ map: woodMap });
  let sharedMapDisposed = 0;
  woodMap.addEventListener('dispose', () => sharedMapDisposed++);
  const requests = [];
  const panel = panelHarness({
    globals: {
      URL,
      window: { location: { href: 'http://localhost/' } },
      document: { createElement: () => ({
        width: 2, height: 1,
        getContext: () => ({ drawImage() {}, getImageData: () => ({ data: maskPixels }) }),
      }) },
      fetch: async () => ({
        ok: true,
        text: async () => fs.readFileSync(path.join(root, 'public', 'models', 'classroom', 'Desk.proto'), 'utf8'),
      }),
    },
    three: { ...THREE, TextureLoader: class {
      async loadAsync(url) { requests.push(url); return new THREE.Texture({}); }
    } },
  }).panel;
  panel.loadVarnishedPineMaterial = async finish => {
    assert.equal(finish, 'desk');
    return woodMaterial;
  };
  panel.createLightClassroomTexture = (source, tint, opacity) => {
    assert.equal(source, woodMap, 'desk atlas must use the warm desk finish');
    assert.equal(opacity, 0, 'the atlas must not wash out the chosen finish');
    return new THREE.CanvasTexture(canvas);
  };
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
    assert.deepEqual(Array.from(outputPixels.slice(0, 4)), [223, 178, 112, 255], 'wood pixels retain the chosen desk color');
    assert.deepEqual(Array.from(outputPixels.slice(4, 8)), [195, 203, 207, 255], 'metal pixels remain silver');
    assert.equal(sharedMapDisposed, 0, 'building desk textures cannot dispose the floor/stage/door map');
    assert.equal(material.color.getHexString(), 'ffffff');
    assert.equal(material.isMeshPhysicalMaterial, true);
    assert.equal(material.clearcoat, 0.18);
    assert.equal(material.envMapIntensity, 0.1, 'wood highlights must stay subdued');
    assert.equal(material.metalness, 0.75);
    assert.equal(requests.length, 3, 'only desk surface-detail maps are loaded separately');
    assert.ok(requests.some(url => url.endsWith('desk_metalness.jpg')));
  } finally {
    geometry.dispose();
    for (const texture of [material.map, material.normalMap, material.roughnessMap, material.metalnessMap]) texture.dispose();
    material.dispose();
    woodMap.dispose();
    woodMaterial.dispose();
  }
});

test('attitude labels use Settings translations in both live and empty states for every supported language', async () => {
  await import('@angular/compiler');
  const { TranslateService, TranslateStore, TranslatePipe, TranslateDefaultParser,
    TranslateFakeCompiler, TranslateFakeLoader, FakeMissingTranslationHandler } = await import('@ngx-translate/core');
  const translate = new TranslateService(new TranslateStore(), new TranslateFakeLoader(),
    new TranslateFakeCompiler(), new TranslateDefaultParser(), new FakeMissingTranslationHandler(),
    true, false, false, 'zh_cn');
  const languageList = JSON.parse(fs.readFileSync(path.join(root, 'public', 'i18n', 'i18n.json'), 'utf8'));
  let updates = 0;
  const pipes = ['ROLL', 'PITCH', 'YAW'].map(() => new TranslatePipe(translate, {
    markForCheck() { updates++; },
  }));
  const keys = ['ROLL', 'PITCH', 'YAW'].map(axis => `CRAZYFLIE_ATTITUDE.${axis}`);
  try {
    for (const { code } of languageList) {
      const data = JSON.parse(fs.readFileSync(path.join(root, 'public', 'i18n', code, `${code}.json`), 'utf8'));
      translate.setTranslation(code, data);
      translate.use(code);
      const labels = keys.map((key, index) => pipes[index].transform(key));
      assert.deepEqual(labels, ['ROLL', 'PITCH', 'YAW'].map(axis => data.CRAZYFLIE_ATTITUDE[axis]));
      assert.ok(labels.every(text => typeof text === 'string' && text.trim() && !keys.includes(text)));
      if (code === 'zh_cn') assert.deepEqual(labels, ['横滚', '俯仰', '偏航']);
      if (code === 'en') assert.deepEqual(labels, ['Roll', 'Pitch', 'Yaw']);
    }
    assert.ok(updates >= languageList.length * 3, 'existing pipes must react when the Settings language changes');
    const componentDir = path.join(root, 'src', 'app', 'editors', 'blockly-editor', 'components', 'blockly',
      'components', 'crazyflie-sim-panel');
    const html = fs.readFileSync(path.join(componentDir, 'crazyflie-sim-panel.component.html'), 'utf8');
    const values = html.match(/<div class="sim-attitude-inset__values">([\s\S]*?)<\/div>/)[1];
    for (const [index, axis] of ['roll', 'pitch', 'yaw'].entries()) {
      assert.ok(values.includes(`'${keys[index]}' | translate`));
      assert.ok(values.includes(`liveAttitude ? (liveAttitude.${axis} | number:'1.0-0') : '--'`),
        'translation and numeric formatting must apply to live/zero and disconnected values alike');
    }
    assert.doesNotMatch(values, />[RPY]\s/);
    const source = fs.readFileSync(path.join(componentDir, 'crazyflie-sim-panel.component.ts'), 'utf8');
    assert.match(source, /imports:\s*\[CommonModule, TranslateModule,/);
  } finally {
    pipes.forEach(pipe => pipe.ngOnDestroy());
  }
});

function registerExampleBlocks() {
  const Blockly = require('blockly');
  const basic = loadGenerator('basic-blocks.ts');
  basic.createCrazyflieBasicToolbox(true);
  basic.registerCrazyflieBasicBlocks();
  Blockly.defineBlocksWithJsonArray(JSON.parse(fs.readFileSync(path.join(root, 'child', 'boards',
    'board-crazyflie', 'template', 'node_modules', '@aily-project', 'lib-crazyflie-motion', 'block.json'), 'utf8')));
  loadGenerator('motion-blocks.ts').registerCrazyflieMotionBlocks(basic.crazyflieGenerator, true);
}

test('example selection preserves the old page, adds rendered-ready blocks and never runs or connects', () => {
  registerExampleBlocks();
  const Blockly = require('blockly');
  const workspace = new Blockly.Workspace();
  const { panel, messages, sim, connection } = panelHarness();
  const savedPages = [];
  workspace.centerOnBlock = id => assert.ok(workspace.getBlockById(id));
  sim.runCode = () => assert.fail('selecting an example must not run it');
  connection.connect = () => assert.fail('selecting an example must not connect to hardware');
  Blockly.serialization.blocks.append({ type: 'math_number', id: 'existing', fields: { NUM: 42 } }, workspace);
  panel.blocklyService = {
    workspace,
    createPage(title) {
      savedPages.push({ title, state: Blockly.serialization.workspaces.save(workspace) });
      workspace.clear();
    },
  };
  Blockly.Events.setGroup('outer-example-group');
  try {
    for (const example of examples.CRAZYFLIE_EXAMPLES) {
      panel.insertExample(example.id);
      assert.equal(Blockly.Events.getGroup(), 'outer-example-group');
      assert.equal(savedPages.length, examples.CRAZYFLIE_EXAMPLES.indexOf(example) + 1, JSON.stringify(messages));
      assert.equal(savedPages.at(-1).title, example.titleKey);
      assert.equal(workspace.getTopBlocks(false).length, 1);
      assert.ok(workspace.getAllBlocks(false).some(block => block.type === 'cf_core_delay'));
    }
    assert.equal(savedPages.length, 4);
    assert.equal(savedPages[0].state.blocks.blocks[0].id, 'existing');
    assert.equal(savedPages[0].state.blocks.blocks[0].fields.NUM, 42);
    assert.deepEqual(messages, ['CRAZYFLIE_EXAMPLES.SELF_TEST_NOTICE',
      'CRAZYFLIE_EXAMPLES.FLIGHT_NOTICE', 'CRAZYFLIE_EXAMPLES.FLIGHT_NOTICE', 'CRAZYFLIE_EXAMPLES.FLIGHT_NOTICE']);
  } finally {
    Blockly.Events.setGroup(false);
    workspace.dispose();
  }
});

test('running, missing blocks and invalid examples cannot replace the existing page', () => {
  registerExampleBlocks();
  const Blockly = require('blockly');
  const workspace = new Blockly.Workspace();
  const { panel, messages } = panelHarness();
  Blockly.serialization.blocks.append({ type: 'math_number', id: 'untouched' }, workspace);
  panel.blocklyService = { workspace, createPage() { assert.fail('no page should be created'); } };
  const delay = Blockly.Blocks.cf_core_delay;
  try {
    panel.running = true;
    panel.insertExample('self-test');
    panel.running = false;
    delete Blockly.Blocks.cf_core_delay;
    panel.insertExample('self-test');
    Blockly.Blocks.cf_core_delay = delay;
    panel.insertExample('unknown');
    assert.ok(workspace.getBlockById('untouched'));
    assert.equal(workspace.getAllBlocks(false).length, 1);
    assert.deepEqual(messages, ['CRAZYFLIE_EXAMPLES.BUSY', 'CRAZYFLIE_EXAMPLES.ERROR', 'CRAZYFLIE_EXAMPLES.ERROR']);
  } finally {
    Blockly.Blocks.cf_core_delay = delay;
    workspace.dispose();
  }
});

test('detected module names share the localized toolbox labels', () => {
  const { panel } = panelHarness();
  const expected = { 'flow-v2': '光流定位', multiranger: '多向测距', 'led-ring': 'LED 灯环', buzzer: '蜂鸣器' };
  const data = JSON.parse(fs.readFileSync(path.join(root, 'public', 'i18n', 'zh_cn', 'zh_cn.json'), 'utf8'));
  for (const [type, name] of Object.entries(expected)) {
    const key = panel.deckLabels[type];
    assert.equal(key.split('.').reduce((value, part) => value[part], data), name);
  }
  const html = fs.readFileSync(path.join(root, 'src', 'app', 'editors', 'blockly-editor', 'components',
    'blockly', 'components', 'crazyflie-sim-panel', 'crazyflie-sim-panel.component.html'), 'utf8');
  assert.match(html, /deckLabel \| translate/);
});

test('furniture reflections are cached, keep floor matte, survive scene switches and release on close', () => {
  const THREE = require('three');
  const texture = new THREE.Texture();
  let roomDisposed = 0;
  let generatorDisposed = 0;
  let environmentDisposed = 0;
  let generated = 0;
  const target = { texture, dispose() { environmentDisposed++; texture.dispose(); } };
  const panel = panelHarness({
    three: { ...THREE, PMREMGenerator: class {
      fromScene(room, sigma, nearPlane, farPlane, options) {
        generated++;
        assert.equal(sigma, 0.08);
        assert.equal(options.size, 128, 'reflection probe must stay small and shared');
        return target;
      }
      dispose() { generatorDisposed++; }
    } },
    modules: { 'three/examples/jsm/environments/RoomEnvironment.js': {
      RoomEnvironment: class { dispose() { roomDisposed++; } },
    } },
  }).panel;
  panel.createClassroomFurnitureEnvironment();
  panel.createClassroomFurnitureEnvironment();
  assert.equal(generated, 1);
  assert.equal(roomDisposed, 1);
  assert.equal(generatorDisposed, 1);
  panel.scene = new THREE.Scene();
  const floor = new THREE.MeshStandardMaterial({ roughness: 0.88 });
  const furniture = panel.createClassroomFurnitureMaterial(floor);
  assert.equal(furniture.isMeshPhysicalMaterial, true);
  assert.equal(furniture.envMap, texture);
  assert.equal(furniture.clearcoat, 0.18);
  assert.equal(floor.envMap, null, 'the reflection probe cannot brighten the floor or other scenery');
  panel.presetInteriorRoot = new THREE.Group();
  panel.presetInteriorRoot.add(panel.createClassroomChair(), panel.createClassroomDeskDrawer());
  panel.scene.add(panel.presetInteriorRoot);
  panel.disposePresetInterior();
  assert.equal(environmentDisposed, 0, 'removing metal frames cannot dispose the shared environment');
  panel.renderer.dispose = () => {};
  panel.ngOnDestroy();
  panel.ngOnDestroy();
  assert.equal(environmentDisposed, 1);
  furniture.dispose();
  floor.dispose();
});

test('furniture reflection failures release temporary GPU helpers and remain explicit', () => {
  let disposed = 0;
  const panel = panelHarness({
    three: { ...require('three'), PMREMGenerator: class {
      fromScene() { throw new Error('test reflection failure'); }
      dispose() { disposed++; }
    } },
    modules: { 'three/examples/jsm/environments/RoomEnvironment.js': {
      RoomEnvironment: class { dispose() { disposed++; } },
    } },
  }).panel;
  assert.throws(() => panel.createClassroomFurnitureEnvironment(), /test reflection failure/);
  assert.equal(disposed, 2);
  assert.equal(panel.classroomFurnitureEnvironment, null);
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

test('classroom helipad uses a distinct matte orange surface with warm ivory markings at the original position', async () => {
  const THREE = require('three');
  const panel = panelHarness({
    globals: {
      URL, window: { location: { href: 'http://localhost/' } },
      document: { createElement: () => ({ getContext: () => null }) },
    },
    three: { ...THREE, TextureLoader: class {
      async loadAsync() { return new THREE.Texture(); }
    } },
  }).panel;
  const deskAsset = { geometry: new THREE.BoxGeometry(), material: new THREE.MeshStandardMaterial() };
  panel.scene = new THREE.Scene();
  panel.applyVarnishedPineFinish = () => {};
  panel.loadClassroomProtoAsset = async () => new THREE.Group();
  panel.loadClassroomDeskAsset = async () => deskAsset;
  try {
    panel.rebuildPresetInterior('classroom', { width: 8.2, depth: 6.2, height: 3 });
    await new Promise(resolve => setImmediate(resolve));
    const root = panel.presetInteriorRoot;
    const base = root.getObjectByName('Classroom desk helipad');
    const top = root.children.find(part => part.geometry?.parameters.radiusTop === 0.126);
    const plate = root.children.find(part => part.geometry?.parameters.width === 0.284);
    const marks = root.children.filter(part => part.material?.color.getHexString() === 'fff3d6');
    assert.equal(base.material.color.getHexString(), 'ad5b2b');
    assert.equal(plate.material.color.getHexString(), 'f6c76a');
    assert.equal(top.material.color.getHexString(), 'ee923a');
    assert.equal(marks.length, 19, 'keep sixteen safety dashes and three H bars');
    const luminance = color => 0.2126 * color.r + 0.7152 * color.g + 0.0722 * color.b;
    assert.ok(marks.every(part => luminance(part.material.color) > luminance(top.material.color)),
      'warm ivory markings must be brighter than the orange landing surface');
    assert.ok(top.material.roughness >= 0.75 && top.material.envMap === null);
    const deskColor = new THREE.Color('#efd0a0');
    const colorDistance = top.material.color.toArray().reduce((sum, value, index) =>
      sum + (value - deskColor.toArray()[index]) ** 2, 0);
    assert.ok(colorDistance > 0.2, 'orange must remain distinct from the warm tabletop');
    near(base.position.x, getClassroomDeskLayout().helipadPose.x);
    near(base.position.z, getClassroomDeskLayout().helipadPose.z);
    near(base.position.y, 0.72201);
    near(base.geometry.parameters.width, 0.3);
    near(top.position.y, 0.74501);
  } finally {
    panel.disposePresetInterior();
    deskAsset.geometry.dispose();
    deskAsset.material.dispose();
  }
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
  assert.equal(chair.children.filter(part => part.name === 'Chair back fastener').length, 2);
  assert.equal(chair.getObjectByName('Chair steel leg').geometry.parameters.radialSegments, 16);
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
  assert.equal(panels.children.length, 10);
  assert.equal(panels.children.filter(part => part.name === 'Lectern raised panel stile').length, 2);
  assert.equal(panels.children.filter(part => part.name === 'Lectern raised panel rail').length, 2);
  assert.ok(panels.getObjectByName('Lectern interior shelf'));
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

test('classroom lighting uses only soft ambient and hemisphere light without direct glare or shadows', () => {
  const { AmbientLight, HemisphereLight } = require('three');
  const lights = panelHarness().panel.createClassroomLighting();
  assert.equal(lights.children.length, 2);
  assert.ok(lights.children.some(light => light instanceof AmbientLight));
  assert.ok(lights.children.some(light => light instanceof HemisphereLight));
  assert.ok(lights.children.every(light => !light.castShadow && light.intensity <= 1));
  assert.ok(lights.children.reduce((sum, light) => sum + light.intensity, 0) <= 2);
  const source = fs.readFileSync(path.join(root, 'src', 'app', 'editors', 'blockly-editor', 'components',
    'blockly', 'components', 'crazyflie-sim-panel', 'crazyflie-sim-panel.component.ts'), 'utf8');
  assert.doesNotMatch(source, /new (?:DirectionalLight|PointLight|SpotLight)\(/);
  assert.match(source, /shadowMap\.enabled = false/);
});

test('disposing legacy directional lights still releases shadow resources', () => {
  const { DirectionalLight } = require('three');
  for (const intensity of [0.45, 2.4]) {
    const panel = panelHarness().panel;
    const lights = new Group();
    const sun = new DirectionalLight('#fff3dd', intensity);
    lights.add(sun);
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
    assert.equal(cars.length, 6);
    const occupiedCarBounds = [];
    for (const car of cars) {
      const carBounds = new Box3().setFromObject(car);
      assert.ok(occupiedCarBounds.every(bounds => !carBounds.intersectsBox(bounds)),
        'parked cars must not overlap one another');
      occupiedCarBounds.push(carBounds);
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
  h.connection.state$.next({ status: 'ready' });
  const live = { ...sample(50, 70), roll: 30, pitch: 20 };
  h.connection.attitudeReception.receive(live, 0);
  h.connection.attitude$.next(live);
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
  h.connection.state$.next({ status: 'disconnected' });
  h.connection.attitude$.next(null);
  h.sim.pose$.value.yaw = Math.PI / 2;
  h.render(40);
  near(h.panel.droneGroup.quaternion.angleTo(attitudeQuaternion(0, 0, 90, Math.PI)), 0);
  assert.ok(h.rendered >= 100);
});

test('panel uses cached connection attitude automatically and does not stop it when the panel closes', () => {
  const h = panelHarness();
  assert.equal(h.panel.attitudeActive, false);
  let stops = 0;
  helperContext.window.electronAPI = { crazyflie: { stopAttitude: () => { stops++; } } };
  const live = { ...sample(50, 30), roll: 12, pitch: 4 };
  h.connection.state$.next({ status: 'ready' });
  h.connection.attitudeReception.receive(live, 0);
  h.connection.attitude$.next(live);
  assert.equal(h.panel.attitudeActive, true);
  assert.equal(h.panel.displayedAttitude, live);
  h.render(13);
  assert.equal(h.panel.attitudePreviewState, 'live');
  h.connection.attitudeError$.next('logger failed');
  assert.equal(h.panel.attitudePreviewState, 'error');
  assert.equal(h.panel.attitudePreviewMessage, 'logger failed');
  let previewDisposed = 0;
  h.panel.attitudePreview = { dispose: () => { previewDisposed++; } };
  h.panel.renderer.dispose = () => {};
  h.panel.ngOnDestroy();
  assert.equal(stops, 0);
  assert.equal(previewDisposed, 1);
  assert.equal(h.connection.attitude$.value, live);
  delete helperContext.window.electronAPI;
});

test('the inset remains real while a simulation runs and does not move the classroom aircraft', () => {
  const h = panelHarness();
  const live = { ...sample(50, 70), roll: 30, pitch: 20 };
  h.connection.state$.next({ status: 'ready' });
  h.connection.attitude$.next(live);
  h.panel.running = true;
  h.panel.updateFlightPath = () => {};
  h.sim.pose$.value.yaw = Math.PI / 2;
  let previewSample;
  h.panel.attitudePreview = { update: value => { previewSample = value; }, render() {} };
  h.render(40);
  assert.equal(previewSample, live);
  near(h.panel.droneGroup.quaternion.angleTo(attitudeQuaternion(0, 0, 90, Math.PI)), 0);
  vectorNear(h.panel.droneGroup.position, [0, 0.06, 0]);
});

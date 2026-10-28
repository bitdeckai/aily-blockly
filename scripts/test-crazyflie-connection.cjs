const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { spawnSync } = require('node:child_process');
const { test } = require('node:test');
const ts = require('typescript');
const root = path.resolve(__dirname, '..');
const tick = () => new Promise(resolve => setImmediate(resolve));

test('both Python workers initialize the native communication runtime before reading the control pipe', () => {
  const python = process.platform === 'win32' ? 'py' : 'python3';
  const args = process.platform === 'win32' ? ['-3'] : [];
  const result = spawnSync(python, [...args, '-B', '-c', `
import base64, builtins, contextlib, io, runpy, sys, types
from pathlib import Path
scripts = Path('child') / 'scripts'
sys.path.insert(0, str(scripts))
import crazyflie_session as session
flow = runpy.run_path(str(scripts / 'crazyflie_run_flow.py'), run_name='startup_test')
initialized = [False]
reading = [False]
original_import = builtins.__import__
def import_runtime(name, *args, **kwargs):
    if name == 'cflib.crtp':
        assert not reading[0], 'native communication runtime imported after control reader started'
        initialized[0] = True
        return types.SimpleNamespace(crtp=object())
    return original_import(name, *args, **kwargs)
class ControlThread:
    def __init__(self, **kwargs): pass
    def start(self):
        assert initialized[0], 'control pipe starts before native communication runtime initialization'
        reading[0] = True
def execute(*args, **kwargs):
    assert initialized[0] and reading[0]
    return {'success': True}
builtins.__import__ = import_runtime
globals_ = flow['main'].__globals__
globals_['_append_cflib_path'] = lambda hint: 'mock'
globals_['Thread'] = ControlThread
globals_['run_flow'] = execute
sys.argv = ['flow', '--code-base64', base64.b64encode(b'cf_test_link()').decode(), '--control-stdin']
with contextlib.redirect_stdout(io.StringIO()):
    assert flow['main']() == 0
initialized[0] = reading[0] = False
session._append_cflib_path = lambda hint: 'mock'
session.Thread = ControlThread
session.serve = execute
sys.argv = ['session', '--uri', 'radio://AABBCCDD0001/80/2M', '--address-hex', 'E7E7E7E7E7']
with contextlib.redirect_stdout(io.StringIO()):
    assert session.main() == 0
assert initialized[0] and reading[0]
`], { cwd: root, encoding: 'utf8', timeout: 10000 });
  assert.equal(result.status, 0, result.stderr);
});

function frontend(api) {
  const cache = new Map();
  function load(name) {
    if (cache.has(name)) return cache.get(name);
    const exports = {};
    const code = ts.transpileModule(fs.readFileSync(path.join(root, 'src', 'app', 'services', `${name}.ts`), 'utf8'), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, experimentalDecorators: true },
    }).outputText;
    vm.runInNewContext(code, {
      exports, window: { crazyflie: api }, Date, console, performance,
      require: name => name === '@angular/core' ? { Injectable: () => type => type }
        : name === './crazyflie-telemetry.service' ? load('crazyflie-telemetry.service')
        : name === './crazyflie-attitude' ? load('crazyflie-attitude') : require(name),
    });
    cache.set(name, exports);
    return exports;
  }
  const telemetry = new (load('crazyflie-telemetry.service').CrazyflieTelemetryService)();
  const connection = new (load('crazyflie-connection.service').CrazyflieConnectionService)(telemetry, { run: fn => fn() });
  return { connection, telemetry };
}

test('header connection subscribes to real state and continuous telemetry, requires a radio selection, and disconnects the backend', async () => {
  let stateEvent, telemetryEvent, attitudeEvent, calls = 0, disconnects = 0, disposed = 0;
  const radios = [{ index: 0, serial: 'AABBCCDD0001' }, { index: 1, serial: 'AABBCCDD0002' }];
  const api = {
    onConnection: callback => { stateEvent = callback; return () => { disposed++; }; },
    onTelemetry: callback => { telemetryEvent = callback; return () => { disposed++; }; },
    onAttitude: callback => { attitudeEvent = callback; return () => { disposed++; }; },
    getConnectionState: async () => ({ status: 'disconnected' }),
    listInterfaces: async () => ({ success: true, radios }),
    connect: async options => {
      calls++;
      assert.equal(options.radioId, radios[1].serial);
      stateEvent({ status: 'ready', uri: 'radio://AABBCCDD0002/80/2M/E7E7E7E7E7',
        addressHex: 'E7E7E7E7E7', radioSerial: radios[1].serial, radioIndex: 1 });
      return { success: true };
    },
    disconnect: async () => { disconnects++; return { success: true }; },
  };
  const { connection, telemetry } = frontend(api);
  await tick();
  await assert.rejects(connection.connect({ uri: 'radio://0/80/2M', addressHex: 'E7E7E7E7E7' }), /多个/);
  assert.equal(calls, 0);
  connection.selectedRadioSerial = radios[1].serial;
  await connection.connect({ uri: 'radio://0/80/2M', addressHex: 'E7E7E7E7E7' });
  await connection.connect({ uri: 'radio://0/80/2M', addressHex: 'E7E7E7E7E7' });
  assert.equal(calls, 1);
  assert.equal(connection.state$.value.status, 'ready');
  assert.match(connection.state$.value.message, /AABBCCDD0002/);
  telemetryEvent({ batteryVolts: 4, batteryPercent: 75, linkQuality: 93 });
  assert.equal(telemetry.telemetry$.value.linkQuality, 93);
  telemetryEvent({ batteryVolts: 3.9, batteryPercent: 62, linkQuality: null });
  assert.equal(telemetry.telemetry$.value.linkQuality, null, 'missing/stale link data must not become zero or retain old data');
  const pose = { type: 'sample', timestampMs: 50, roll: 12, pitch: -8, yaw: 40, source: 'idle' };
  attitudeEvent(pose);
  assert.equal(connection.attitude$.value.roll, 12, 'attitude is cached even when the 3D panel is hidden');
  attitudeEvent({ type: 'error', message: 'No fresh attitude' });
  assert.equal(connection.attitudeError$.value, 'No fresh attitude');
  assert.equal(connection.attitude$.value, pose, 'an attitude-only error holds the last measured sample');
  assert.equal(connection.state$.value.status, 'ready', 'an attitude-only failure must not disconnect a healthy link');
  attitudeEvent({ ...pose, timestampMs: 100, roll: 20 });
  assert.equal(connection.attitudeError$.value, null);
  attitudeEvent({ ...pose, timestampMs: 150, roll: NaN });
  assert.match(connection.attitudeError$.value, /无效/);
  assert.equal(connection.attitude$.value.roll, 20, 'invalid samples must not reach the model');
  stateEvent({ status: 'error', message: 'USB removed' });
  assert.equal(telemetry.telemetry$.value, null);
  assert.equal(connection.state$.value.status, 'error');
  assert.equal(connection.attitude$.value, null);
  attitudeEvent({ ...pose, timestampMs: 200 });
  assert.equal(connection.attitude$.value, null, 'late samples cannot revive a disconnected aircraft');
  connection.setResult(true, 'USB detected');
  assert.notEqual(connection.state$.value.status, 'ready', 'detecting a dongle is not an aircraft connection');
  await connection.disconnect();
  assert.equal(disconnects, 1);
  assert.equal(connection.state$.value.status, 'disconnected');
  connection.ngOnDestroy();
  assert.equal(disposed, 3);
});

test('radio discovery handles hotplug and renumbering, shares pending reads and recovers after enumeration errors', async () => {
  const first = { index: 0, serial: 'AABBCCDD0001' };
  const second = { index: 1, serial: 'AABBCCDD0002' };
  let radios = [], stateEvent, reads = 0, connects = 0;
  const api = {
    onConnection: callback => { stateEvent = callback; return () => {}; },
    onTelemetry: () => () => {},
    onAttitude: () => () => {},
    getConnectionState: async () => ({ status: 'disconnected' }),
    listInterfaces: async () => { reads++; return { success: true, radios }; },
    connect: async () => { connects++; return { success: true }; },
    disconnect: async () => ({ success: true }),
  };
  const { connection } = frontend(api);
  await tick();
  await connection.refreshRadios();
  assert.equal(connection.radios.length, 0);
  radios = [first, second];
  await connection.refreshRadios();
  assert.equal(connection.selectedRadioSerial, '', 'multiple newly plugged devices require a choice');
  connection.selectedRadioSerial = second.serial;
  radios = [{ ...second, index: 0 }, { ...first, index: 1 }];
  await connection.refreshRadios();
  assert.equal(connection.selectedRadioSerial, second.serial, 'selection follows USB serial, not enumeration order');
  assert.equal(connection.radios[0].index, 0);
  radios = [first];
  await connection.refreshRadios();
  assert.equal(connection.selectedRadioSerial, first.serial, 'removing the selection immediately selects the sole remaining device');
  radios = [];
  await connection.refreshRadios();
  assert.equal(connection.selectedRadioSerial, '');
  radios = [second];
  await connection.refreshRadios();
  assert.equal(connection.selectedRadioSerial, second.serial, 'a device inserted after startup is selected');

  let finishRead;
  api.listInterfaces = () => {
    reads++;
    return new Promise(resolve => { finishRead = resolve; });
  };
  const before = reads;
  const pending = connection.refreshRadios();
  assert.equal(connection.refreshRadios(), pending, 'focus and automatic polling share one in-flight USB read');
  assert.equal(reads, before + 1);
  finishRead({ success: true, radios: [first] });
  await pending;
  api.listInterfaces = async () => ({ success: false, message: 'USB enumeration failed' });
  await assert.rejects(connection.refreshRadios(), /USB enumeration failed/);
  assert.equal(connection.radios[0].serial, first.serial, 'failure does not masquerade as an empty device list');

  api.listInterfaces = async () => ({ success: true, radios: [second] });
  stateEvent({ status: 'checking', radioSerial: first.serial });
  await connection.refreshRadios();
  assert.equal(connection.selectedRadioSerial, first.serial, 'late refresh cannot change a connection being opened');
  stateEvent({ status: 'ready', radioSerial: first.serial });
  await connection.refreshRadios();
  assert.equal(connection.selectedRadioSerial, first.serial, 'discovery cannot switch the connected aircraft');
  stateEvent({ status: 'disconnected' });
  await connection.refreshRadios();
  assert.equal(connection.selectedRadioSerial, second.serial, 'discovery resumes after disconnect or unplug');
  assert.equal(connects, 0, 'discovery never connects or starts motors');
  connection.ngOnDestroy();
});

test('telemetry preserves unknown values and allows genuine zero readings', () => {
  const { telemetry } = frontend(undefined);
  telemetry.setTelemetry({});
  assert.equal(telemetry.telemetry$.value.batteryPercent, null);
  assert.equal(telemetry.telemetry$.value.batteryVolts, null);
  assert.equal(telemetry.telemetry$.value.linkQuality, null);
  telemetry.setTelemetry({ linkQuality: 0, batteryPercent: 0 });
  assert.equal(telemetry.telemetry$.value.linkQuality, 0);
  telemetry.setTelemetry({ linkQuality: null });
  assert.equal(telemetry.telemetry$.value.linkQuality, null);
});

function workerAdapter() {
  const file = path.join(root, 'electron', 'crazyflie-session.js');
  let child;
  let launches = 0, kills = 0;
  const exports = {};
  const events = [];
  const context = {
    module: { exports }, exports, setTimeout, clearTimeout,
    require: name => name === 'child_process' ? { spawn: () => {
      launches++;
      child = new EventEmitter();
      child.stdin = new PassThrough();
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      child.kill = () => { kills++; child.emit('close', 1); };
      return child;
    } } : require(name),
  };
  vm.runInNewContext(fs.readFileSync(file, 'utf8'), context);
  const worker = context.module.exports.startCrazyflieSession({
    pythonCmd: 'py', scriptPath: 'worker.py', connectionArgs: [], onEvent: event => events.push(event), onClose() {},
  });
  return { worker, events, emit: event => child.stdout.write(JSON.stringify(event) + '\n'),
    close: code => child.emit('close', code), input: () => child.stdin.read()?.toString() || '',
    get launches() { return launches; }, get kills() { return kills; } };
}

test('worker transport never reports a failed active flight as finished before landing cleanup', async () => {
  const h = workerAdapter();
  h.emit({ type: 'state', state: 'ready' });
  await h.worker.ready;
  let finished = false;
  const run = h.worker.request('run', { code: 'cf_takeoff()', timeoutMs: 20000 }).then(result => { finished = true; return result; });
  await tick();
  const request = JSON.parse(h.input().trim());
  h.emit({ type: 'state', state: 'error', message: 'telemetry lost' });
  h.emit({ type: 'state', state: 'ready' });
  await tick();
  assert.equal(finished, false);
  assert.equal(h.kills, 0, 'must not kill a process that may still be landing');
  assert.equal(h.events.filter(event => event.state === 'ready').length, 1, 'late ready cannot revive a failed connection');
  assert.match(h.input(), /shutdown/);
  h.emit({ type: 'result', id: request.id, result: { success: false, message: 'landed after failure' } });
  assert.equal((await run).success, false);
  h.close(0);
  assert.equal(h.launches, 1, 'a failed plan must never be replayed');
});

test('worker cancel stays on the same connection and idle shutdown closes without a second process', async () => {
  const h = workerAdapter();
  h.emit({ type: 'state', state: 'ready' });
  await h.worker.ready;
  const run = h.worker.request('run', { code: 'cf_land()', timeoutMs: 20000 });
  await tick();
  const request = JSON.parse(h.input().trim());
  h.worker.cancel();
  assert.match(h.input(), /cancel/);
  h.emit({ type: 'result', id: request.id, result: { success: false, message: 'cancelled after landing' } });
  await run;
  const stop = h.worker.stop();
  h.emit({ type: 'state', state: 'ready' });
  assert.match(h.input(), /shutdown/);
  h.close(0);
  await stop;
  assert.equal(h.launches, 1);
  assert.equal(h.kills, 0);
});

test('Python persistent session reuses the physical connection, streams telemetry, and never arms on connect', () => {
  const result = spawnSync('py', ['-3', '-B', '-c', `
import sys, types, queue, time
from pathlib import Path
from threading import Event, Thread
from contextlib import contextmanager, redirect_stdout
import io
sys.path.insert(0, str(Path('child') / 'scripts'))
import crazyflie_session as session
import crazyflie_run_flow as flow
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
connections, actions, configs, messages = [], [], [], []
bad_battery = [False]
class Config:
    def __init__(self, *args, **kwargs):
        self.data_received_cb, self.error_cb = Callback(), Callback()
        self.done = Event()
        self.deleted = False
        self.worker = None
        configs.append(self)
    def add_variable(self, *args): pass
    def start(self):
        def produce():
            while not self.done.is_set():
                self.data_received_cb.call(0, {'pm.vbat': float('nan') if bad_battery[0] else 4.0}, self)
                self.done.wait(0.05)
        self.worker = Thread(target=produce)
        self.worker.start()
    def stop(self):
        self.done.set()
        if self.worker: self.worker.join()
    def delete(self): self.deleted = True
class Connection:
    def __init__(self, uri):
        connections.append(uri)
        self.closed = False
        self.cf = types.SimpleNamespace(
            log=types.SimpleNamespace(add_config=lambda cfg: None),
            link_statistics=types.SimpleNamespace(link_quality_updated=Callback()),
            disconnected=Callback(), connection_lost=Callback(),
            platform=types.SimpleNamespace(send_arming_request=lambda value: actions.append('arm')))
    def __enter__(self): return self
    def __exit__(self, *args): self.closed = True
class Commander:
    def __init__(self, scf): pass
    def take_off(self, **kwargs): actions.append('takeoff')
    def land(self, **kwargs): actions.append('land')
observations = []
active_observers = [0]
@contextmanager
def attitude(scf, emit, **kwargs):
    observations.append(scf)
    active_observers[0] += 1
    assert active_observers[0] == 1, 'idle and flight must not open concurrent attitude logs'
    emit({'type':'sample', 'timestampMs':len(observations)*50, 'roll':12, 'pitch':-4, 'yaw':30})
    try: yield lambda: None
    finally: active_observers[0] -= 1
import crazyflie_attitude
crazyflie_attitude.attitude_logging = attitude
modules['cflib.crtp'].init_drivers = lambda **kwargs: None
modules['cflib.crazyflie.syncCrazyflie'].SyncCrazyflie = Connection
modules['cflib.crazyflie.log'].LogConfig = Config
modules['cflib.crazyflie.syncLogger'].SyncLogger = object
modules['cflib.positioning.motion_commander'].MotionCommander = Commander
modules['cflib.crtp.radiodriver'].RadioDriver = lambda: (_ for _ in ()).throw(AssertionError('second radio opened'))
modules['cflib.utils.multiranger'].Multiranger = object
flow.interruptible_sleep = lambda seconds, check: check()
requests = queue.Queue()
requests.put({'id': 0, 'action': 'run', 'code': 'not_a_crazyflie_flow()'})
requests.put({'id': 1, 'action': 'run', 'code': 'cf_crazyflie_link()\\ncf_print("first")'})
requests.put({'id': 2, 'action': 'run', 'code': 'cf_crazyflie_link()\\ncf_print("again")'})
requests.put({'id': 3, 'action': 'run', 'code': 'cf_motion("takeoff", [0.5, 0.2])\\ncf_motion("land", [0.2])'})
stop, shutdown = Event(), Event()
def emit(message):
    messages.append(message)
    if message.get('type') == 'result':
        assert message['result']['success'] == (message['id'] != 0), message
        if message['id'] < 3: assert not actions, 'connecting must never arm or move motors'
        if message['id'] == 3: shutdown.set()
with redirect_stdout(io.StringIO()):
    session.serve('radio://AABBCCDD0002/80/2M/E7E7E7E7E7', 'E7E7E7E7E7', emit, requests, stop, shutdown)
assert len(connections) == 1, connections
assert actions == ['arm', 'takeoff', 'land', 'land'], actions
assert len(observations) == 8 and len(set(map(id, observations))) == 1, observations
assert active_observers[0] == 0
assert any(m['type'] == 'attitude' and m['payload'].get('roll') == 12 for m in messages), messages
assert next(i for i,m in enumerate(messages) if m['type'] == 'attitude') < next(i for i,m in enumerate(messages) if m['type'] == 'result')
assert any(m['type'] == 'telemetry' and m['payload']['batteryVolts'] == 4 for m in messages)
assert all(c.deleted and not c.data_received_cb.callbacks for c in configs)
bad_battery[0] = True
messages.clear()
stop, shutdown = Event(), Event()
try:
    session.serve('radio://AABBCCDD0002/80/2M/E7E7E7E7E7', 'E7E7E7E7E7', messages.append, queue.Queue(), stop, shutdown)
except RuntimeError as error: assert 'Invalid battery' in str(error), error
else: raise AssertionError('invalid battery accepted')
assert not any(m['type'] == 'state' and m['state'] == 'ready' for m in messages)
bad_battery[0] = False
shutdown = Event()
shutdown.set()
count = len(connections)
session.serve('radio://mock', 'E7E7E7E7E7', messages.append, queue.Queue(), Event(), shutdown)
assert len(connections) == count, 'shutdown before startup must not open the radio'
@contextmanager
def failed_observer(*args, **kwargs):
    raise RuntimeError('mock observer enter failed')
    yield
crazyflie_attitude.attitude_logging = failed_observer
requests = queue.Queue()
requests.put({'id': 4, 'action': 'observe', 'enabled': True})
shutdown = Event()
def observer_result(message):
    if message['type'] == 'result':
        assert not message['result']['success']
        assert 'observer enter failed' in message['result']['message']
        shutdown.set()
session.serve('radio://mock', 'E7E7E7E7E7', observer_result, requests, Event(), shutdown)
original_clock = session.time.monotonic
elapsed = [0]
session.time.monotonic = lambda: original_clock() + elapsed[0]
try:
    failed = Event()
    errors = []
    def stale(message):
        errors.append(message)
        failed.set()
    with session.connection_telemetry(Connection('radio://mock'), Config, lambda message: None, stale) as healthy:
        configs[-1].stop()
        elapsed[0] = 4
        assert failed.wait(1), 'watchdog must detect stale data even while a flow is blocked'
        assert 'stale' in errors[0]
        try: healthy()
        except TimeoutError: pass
        else: raise AssertionError('stale battery accepted')
finally:
    session.time.monotonic = original_clock
print('one persistent connection, no implicit motor action, and telemetry failure cleanup passed')
`], { cwd: root, encoding: 'utf8', timeout: 20000 });
  assert.equal(result.status, 0, result.stderr || String(result.error));
});

test('Python control channel rejects non-object requests explicitly without accessing hardware', () => {
  const result = spawnSync('py', ['-3', '-B', '-c', `
import io, json, sys
from pathlib import Path
from contextlib import redirect_stdout
sys.path.insert(0, str(Path('child') / 'scripts'))
import crazyflie_session as session
session._append_cflib_path = lambda hint: True
session.serve = lambda uri, address, emit, requests, stop, shutdown: shutdown.wait(1)
sys.argv = ['worker', '--uri', 'radio://mock', '--address-hex', 'E7E7E7E7E7']
sys.stdin = io.StringIO('[]\\n')
output = io.StringIO()
with redirect_stdout(output):
    session.main()
messages = [json.loads(line) for line in output.getvalue().splitlines()]
assert any(m.get('state') == 'error' and 'Invalid session request' in m['message'] for m in messages), messages
assert not any(m.get('state') == 'ready' for m in messages), messages
`], { cwd: root, encoding: 'utf8', timeout: 5000 });
  assert.equal(result.status, 0, result.stderr || String(result.error));
});

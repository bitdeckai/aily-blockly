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
      exports, window: { crazyflie: api }, Date, console, performance, setTimeout, clearTimeout,
      require: name => name === '@angular/core' ? { Injectable: () => type => type }
        : name === './crazyflie-telemetry.service' ? load('crazyflie-telemetry.service')
        : name === './crazyflie-attitude' ? load('crazyflie-attitude')
        : name === './crazyflie-mapping' ? load('crazyflie-mapping') : require(name),
    });
    cache.set(name, exports);
    return exports;
  }
  const telemetry = new (load('crazyflie-telemetry.service').CrazyflieTelemetryService)();
  const connection = new (load('crazyflie-connection.service').CrazyflieConnectionService)(telemetry, { run: fn => fn() });
  return { connection, telemetry };
}

function emergencyHeader(policy = 'real-only') {
  const file = path.join(root, 'src', 'app', 'main-window', 'components', 'header', 'header.component.ts');
  const ast = ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
  const component = ast.statements.find(node => ts.isClassDeclaration(node) && node.name?.text === 'HeaderComponent');
  const methods = component.members.filter(node =>
    ['emergencyStopDisabled', 'emergencyStopCrazyflie', 'runSelectedCrazyflieMode'].includes(node.name?.getText(ast)));
  assert.equal(methods.length, 3);
  const code = ts.transpileModule(`class Header { ${methods.map(node => node.getText(ast)).join('\n')} }
    exports.Header = Header;`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  const exports = {};
  vm.runInNewContext(code, { exports, Promise, Error });
  const header = new exports.Header(), calls = [];
  Object.assign(header, {
    runtimePolicy: policy, connectionState: { status: 'ready', busy: true }, crazyflieRunInProgress: true,
    emergencyStopInProgress: false, canShowSimulatorControls: () => true,
    crazyflieConnectionService: { emergencyStop: async () => { calls.push('packet'); } },
    crazyflieSimService: { cancelRun: () => { calls.push('sim-stop'); } },
    cameraGestureService: {
      cancelProgram: () => calls.push('program-stop'),
      stop: async () => { calls.push('gesture-stop'); },
    },
    message: { warning: text => calls.push(['warning', text]), error: text => calls.push(['error', text]) },
    cd: { markForCheck() {} },
  });
  return { header, calls };
}

test('actual header emergency button sends before stopping gesture actions, works during runs and never flies in simulation', async () => {
  for (const policy of ['real-only', 'sim-real']) {
    const h = emergencyHeader(policy);
    h.header.cameraGestureService.stop = () => new Promise(() => {});
    assert.equal(h.header.emergencyStopDisabled, false, 'flight busy cannot disable emergency stop');
    await h.header.emergencyStopCrazyflie();
    assert.equal(h.calls[0], 'packet', 'send must not wait for gesture cancellation or the current motion');
    assert.equal(h.header.emergencyStopInProgress, false);
  }
  const sim = emergencyHeader('sim-only');
  await sim.header.emergencyStopCrazyflie();
  assert.ok(sim.calls.includes('sim-stop'));
  assert.ok(!sim.calls.includes('packet'));
  const idle = emergencyHeader();
  idle.header.connectionState.status = 'disconnected';
  assert.equal(idle.header.emergencyStopDisabled, true);
  await idle.header.emergencyStopCrazyflie();
  assert.ok(!idle.calls.includes('packet'));
  const failed = emergencyHeader();
  failed.header.crazyflieConnectionService.emergencyStop = async () => { throw new Error('Radio write failed'); };
  await failed.header.emergencyStopCrazyflie();
  assert.ok(failed.calls.some(call => Array.isArray(call) && call[0] === 'error' && call[1] === 'Radio write failed'));
  assert.equal(failed.header.emergencyStopInProgress, false);
  failed.header.crazyflieRunInProgress = false;
  failed.header.connectionState.emergencyStopped = true;
  failed.header.runCrazyflieRealFlight = () => assert.fail('cannot resume after emergency');
  await failed.header.runSelectedCrazyflieMode();
});

test('emergency toolbar is a native button outside the scrolling controls and the actual preload invokes its dedicated IPC', async () => {
  const folder = path.join(root, 'src', 'app', 'main-window', 'components', 'header');
  const { parseTemplate } = await import('@angular/compiler');
  const template = parseTemplate(fs.readFileSync(path.join(folder, 'header.component.html'), 'utf8'), 'header.component.html');
  assert.equal(template.errors, null);
  let emergency;
  function visit(nodes, scrolling = false) {
    for (const node of nodes) {
      const classes = node.attributes?.find(attribute => attribute.name === 'class')?.value.split(' ') || [];
      const inside = scrolling || classes.includes('cf-flight-controls');
      if (classes.includes('cf-emergency-stop')) {
        emergency = node;
        assert.equal(node.name, 'button');
        assert.equal(inside, false, 'emergency cannot be hidden in the horizontal scroll area');
      }
      if (node.children) visit(node.children, inside);
      if (node.branches) visit(node.branches, inside);
    }
  }
  visit(template.nodes);
  assert.ok(emergency);
  assert.equal(emergency.inputs.find(input => input.name === 'disabled').value.source, 'emergencyStopDisabled');
  assert.equal(emergency.outputs.find(output => output.name === 'click').handler.source, 'emergencyStopCrazyflie()');
  assert.match(emergency.attributes.find(attribute => attribute.name === 'aria-label').value, /不是降落/);
  const preload = fs.readFileSync(path.join(root, 'electron', 'preload.js'), 'utf8');
  const ast = ts.createSourceFile('preload.js', preload, ts.ScriptTarget.Latest, true);
  let wrapper;
  function find(node) {
    if (ts.isPropertyAssignment(node) && node.name.getText(ast) === 'emergencyStop') wrapper = node.initializer.getText(ast);
    ts.forEachChild(node, find);
  }
  find(ast);
  assert.ok(wrapper);
  const calls = [];
  const invoke = vm.runInNewContext(`(${wrapper})`, { ipcRenderer: {
    invoke: async (...args) => { calls.push(args); return { success: true }; },
  } });
  assert.equal((await invoke()).success, true);
  assert.deepEqual(calls, [['crazyflie-emergency-stop']]);
});

test('connection emergency uses the existing busy connection, blocks readiness, preserves failures and never auto-connects', async () => {
  let stateEvent, telemetryEvent, sent = 0, fail = false;
  const { connection } = frontend({
    connect: async () => assert.fail('emergency cannot connect'),
    disconnect: async () => assert.fail('emergency cannot disconnect'),
    listInterfaces: async () => assert.fail('emergency cannot scan'),
    getConnectionState: async () => ({ status: 'disconnected' }),
    onConnection: callback => { stateEvent = callback; return () => {}; },
    onTelemetry: callback => { telemetryEvent = callback; return () => {}; },
    onAttitude: () => () => {},
    emergencyStop: async () => { sent++; return { success: !fail, message: 'Send failed' }; },
  });
  await tick();
  await assert.rejects(connection.emergencyStop(), /请先连接/);
  assert.equal(sent, 0);
  stateEvent({ status: 'ready', busy: true });
  await connection.emergencyStop();
  assert.equal(sent, 1);
  assert.equal(connection.state$.value.busy, true, 'sending an emergency packet does not finish the pending motion');
  telemetryEvent({ flightReadiness: { source: 'supervisor', value: 8 } });
  assert.equal(connection.flightReadiness$.value.status, 'blocked');
  fail = true;
  await assert.rejects(connection.emergencyStop(), /Send failed/);
  stateEvent({ status: 'disconnected' });
  stateEvent({ status: 'ready' });
  telemetryEvent({ flightReadiness: { source: 'supervisor', value: 8 } });
  assert.equal(connection.flightReadiness$.value.status, 'ready');
  connection.ngOnDestroy();
});

test('Python emergency dispatch uses supervisor or legacy localization immediately and latches cancellation without landing or arming', () => {
  const result = spawnSync('py', ['-3', '-B', '-c', `
import io, json, sys, types
from pathlib import Path
from threading import Event
sys.path.insert(0, str(Path('child') / 'scripts'))
import crazyflie_session as session
for name in ('supervisor', 'loc'):
    calls, stop = [], Event()
    control = session.EmergencyStopControl(stop)
    cf = types.SimpleNamespace(**{name: types.SimpleNamespace(send_emergency_stop=lambda: calls.append('emergency'))})
    with control.connected(cf):
        control.request()
        assert calls == ['emergency'] and control.requested.is_set() and stop.is_set()
    try: control.request()
    except RuntimeError as error: assert 'Connect' in str(error)
    else: raise AssertionError('Disconnected emergency accepted')
for api in (types.SimpleNamespace(), types.SimpleNamespace(supervisor=types.SimpleNamespace(
        send_emergency_stop=lambda: (_ for _ in ()).throw(OSError('radio write failed'))))):
    stop, control = Event(), None
    control = session.EmergencyStopControl(stop)
    with control.connected(api):
        try: control.request()
        except (RuntimeError, OSError): pass
        else: raise AssertionError('Missing/broken emergency API accepted')
        assert stop.is_set() and control.requested.is_set(), 'failure cannot resume remaining commands'
ready, sent, done = Event(), Event(), Event()
class Input:
    def __iter__(self):
        assert ready.wait(2)
        yield '{"id":7,"action":"emergency-stop"}\\n'
        assert done.wait(2)
def blocked_flight(uri, address, emit, requests, stop, shutdown, mapping, emergency):
    with emergency.connected(types.SimpleNamespace(supervisor=types.SimpleNamespace(send_emergency_stop=sent.set))):
        ready.set()
        try:
            assert sent.wait(2), 'emergency reader blocked behind the flight'
            assert requests.empty(), 'emergency was queued as a normal flight'
            assert stop.is_set() and emergency.requested.is_set()
        finally: done.set()
cflib = sys.modules['cflib'] = types.ModuleType('cflib')
cflib.crtp = sys.modules['cflib.crtp'] = types.ModuleType('cflib.crtp')
session._append_cflib_path = lambda hint: 'mock'
session.serve = blocked_flight
sys.stdin = Input()
sys.argv = ['session', '--uri', 'radio://mock', '--address-hex', 'E7E7E7E7E7']
output = io.StringIO()
from contextlib import redirect_stdout
with redirect_stdout(output): assert session.main() == 0
messages = [json.loads(line) for line in output.getvalue().splitlines()]
assert any(m.get('id') == 7 and m['result']['success'] for m in messages), messages
`], { cwd: root, encoding: 'utf8', timeout: 10000 });
  assert.equal(result.status, 0, result.stderr || result.stdout);
});

test('mapping bridge requires an existing connection, validates samples, reports bad data and invalidates on disconnect', async () => {
  const callbacks = {};
  const controls = [];
  const api = {
    connect: async () => assert.fail('mapping must not connect'),
    disconnect: async () => assert.fail('mapping must not disconnect'),
    listInterfaces: async () => assert.fail('mapping must not enumerate or open another radio'),
    getConnectionState: async () => ({ status: 'disconnected' }),
    onConnection: cb => { callbacks.state = cb; return () => {}; },
    onTelemetry: cb => () => {},
    onAttitude: cb => () => {},
    onMapping: cb => { callbacks.mapping = cb; return () => {}; },
    setMapping: async enabled => { controls.push(enabled); return { success: true }; },
  };
  const { connection } = frontend(api);
  const events = [];
  connection.mapping$.subscribe(event => events.push(event));
  await tick();
  await assert.rejects(connection.setMapping(true), /先连接/);
  callbacks.state({ status: 'ready' });
  await connection.setMapping(true);
  const sample = { type: 'sample', timestampMs: 100, poseTimestampMs: 100, epoch: 0,
    x: 0, y: 0, z: 0, roll: 0, pitch: 0, yaw: 0,
    ranges: { front: 1, back: null, left: null, right: null, up: null } };
  callbacks.mapping(sample);
  assert.equal(events.at(-1), sample);
  assert.ok(connection.detectedDecks$.value.includes('multiranger'));
  callbacks.mapping({ ...sample, poseTimestampMs: 0 });
  assert.equal(events.at(-1).type, 'error');
  callbacks.state({ status: 'disconnected' });
  assert.equal(events.at(-1).type, 'reference');
  assert.deepEqual(controls, [true]);
  connection.ngOnDestroy();
});

test('connection telemetry selects supported firmware permission logs without adding a connection or motor command', () => {
  const python = process.platform === 'win32' ? 'py' : 'python3';
  const args = process.platform === 'win32' ? ['-3'] : [];
  const result = spawnSync(python, [...args, '-B', '-c', `
import sys, types
from pathlib import Path
sys.path.insert(0, str(Path('child') / 'scripts'))
from crazyflie_session import connection_telemetry
class Callback:
    def __init__(self): self.callbacks = []
    def add_callback(self, callback): self.callbacks.append(callback)
    def remove_callback(self, callback): self.callbacks.remove(callback)
    def call(self, *args):
        for callback in list(self.callbacks): callback(*args)
class Config:
    def __init__(self, *args):
        self.variables = []
        self.data_received_cb, self.error_cb = Callback(), Callback()
        self.stopped = self.deleted = False
        configs.append(self)
    def add_variable(self, *args): self.variables.append(args)
    def start(self): self.data_received_cb.call(0, data, self)
    def stop(self): self.stopped = True
    def delete(self): self.deleted = True
for available, expected, name, value in [
    ({'supervisor.info', 'sys.canfly'}, 'supervisor', 'supervisor.info', 64),
    ({'sys.canfly'}, 'legacy', 'sys.canfly', 0),
    (set(), 'unavailable', None, None),
    ({'supervisor.info'}, 'invalid', 'supervisor.info', None),
    ({'supervisor.info'}, 'invalid', 'supervisor.info', float('nan')),
    ({'supervisor.info'}, 'invalid', 'supervisor.info', 65536),
    ({'supervisor.info'}, 'invalid', 'supervisor.info', True),
    ({'sys.canfly'}, 'invalid', 'sys.canfly', 2),
]:
    configs, messages, errors = [], [], []
    data = {'pm.vbat': 4.0}
    if name and value is not None: data[name] = value
    quality = Callback()
    scf = types.SimpleNamespace(cf=types.SimpleNamespace(
        log=types.SimpleNamespace(add_config=lambda cfg: None, toc=types.SimpleNamespace(
            get_element_by_complete_name=lambda name: object() if name in available else None)),
        link_statistics=types.SimpleNamespace(link_quality_updated=quality),
        disconnected=Callback(), connection_lost=Callback()))
    with connection_telemetry(scf, Config, messages.append, errors.append) as healthy:
        healthy()
        expected_value = None if expected == 'invalid' else value
        assert messages[0]['payload']['flightReadiness'] == {'source': expected, 'value': expected_value}, messages
        expected_variables = [('pm.vbat', 'float')]
        if name: expected_variables.append((name, 'uint16_t' if name == 'supervisor.info' else 'uint8_t'))
        assert configs[0].variables == expected_variables, configs[0].variables
        quality.call(90)
        assert 'flightReadiness' not in messages[-1]['payload'], 'link quality must not refresh old permission'
    assert not errors, errors
    assert configs[0].stopped and configs[0].deleted
    assert not quality.callbacks and not configs[0].data_received_cb.callbacks
`], { cwd: root, encoding: 'utf8', timeout: 10000 });
  assert.equal(result.status, 0, result.stderr || String(result.error));
});

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

test('firmware flight permission is distinct from connection health, expires, and clears on disconnect', async t => {
  let stateEvent, telemetryEvent;
  const { connection } = frontend({
    onConnection: callback => { stateEvent = callback; return () => {}; },
    onTelemetry: callback => { telemetryEvent = callback; return () => {}; },
    onAttitude: () => () => {},
    getConnectionState: async () => ({ status: 'disconnected' }),
    listInterfaces: async () => ({ success: true, radios: [] }),
    connect: async () => ({ success: true }), disconnect: async () => ({ success: true }),
  });
  t.after(() => connection.ngOnDestroy());
  await tick();
  stateEvent({ status: 'ready' });
  assert.equal(connection.flightReadiness$.value.status, 'unknown', 'a healthy radio does not prove flight permission');
  for (const [source, value, status, message] of [
    ['supervisor', 8, 'ready', /允许起飞/],
    ['supervisor', 24, 'flying', /飞行中/],
    ['supervisor', 1, 'needs-arming', /解锁/],
    ['supervisor', 64, 'blocked', /锁定.*重启/],
    ['supervisor', 32, 'blocked', /翻倒/],
    ['supervisor', 128, 'blocked', /碰撞/],
    ['supervisor', 2048, 'blocked', /扩展板/],
    ['supervisor', 0, 'blocked', /未允许/],
    ['legacy', 1, 'ready', /允许起飞/],
    ['legacy', 0, 'blocked', /未允许/],
    ['unavailable', null, 'unknown', /固件.*未提供/],
    ['supervisor', 65536, 'unknown', /无效/],
    ['supervisor', true, 'unknown', /无效/],
    ['supervisor', -1, 'unknown', /无效/],
    ['supervisor', 1.5, 'unknown', /无效/],
    ['legacy', 2, 'unknown', /无效/],
    ['supervisor', 72, 'blocked', /锁定.*重启/],
    ['supervisor', 40, 'blocked', /翻倒/],
  ]) {
    telemetryEvent({ flightReadiness: { source, value } });
    assert.equal(connection.flightReadiness$.value.status, status);
    assert.match(connection.flightReadiness$.value.message, message);
    assert.equal(connection.state$.value.status, 'ready', 'flight permission must not rewrite connection health');
  }
  telemetryEvent({ flightReadiness: { source: 'supervisor', value: 8 } });
  const batteryOnly = setInterval(() => telemetryEvent({ batteryVolts: 4, linkQuality: 99 }), 100);
  try { await new Promise(resolve => setTimeout(resolve, 1650)); }
  finally { clearInterval(batteryOnly); }
  assert.equal(connection.flightReadiness$.value.status, 'unknown');
  assert.match(connection.flightReadiness$.value.message, /过期/);
  telemetryEvent({ flightReadiness: { source: 'supervisor', value: 8 } });
  stateEvent({ status: 'disconnected' });
  assert.equal(connection.flightReadiness$.value.status, 'unknown');
  telemetryEvent({ flightReadiness: { source: 'supervisor', value: 8 } });
  assert.equal(connection.flightReadiness$.value.status, 'unknown', 'late data cannot resurrect permission');
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

test('mapping control and samples share the worker during flight without cancelling or claiming the flight has finished', async () => {
  const h = workerAdapter();
  h.emit({ type: 'state', state: 'ready' });
  await h.worker.ready;
  const run = h.worker.request('run', { code: 'cf_takeoff()', timeoutMs: 20000 });
  await tick();
  const flight = JSON.parse(h.input().trim());
  const mapping = h.worker.request('mapping', { enabled: true });
  await tick();
  const request = JSON.parse(h.input().trim());
  assert.equal(request.action, 'mapping');
  assert.equal(h.worker.running, true);
  h.emit({ type: 'mapping', payload: { type: 'sample', timestampMs: 100 } });
  h.emit({ type: 'result', id: request.id, result: { success: true } });
  assert.equal((await mapping).success, true);
  assert.equal(h.worker.running, true);
  assert.ok(h.events.some(event => event.type === 'mapping'));
  assert.equal(h.input(), '', 'mapping must not write a cancel, arming or motion request');
  h.emit({ type: 'result', id: flight.id, result: { success: true } });
  await run;
  h.close(0);
  assert.equal(h.launches, 1);
  assert.equal(h.kills, 0);
});

test('worker emergency sends a distinct command during a pending flight without cancelling by queue, spawning or completing the flight', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const h = workerAdapter();
  h.emit({ type: 'state', state: 'ready' });
  await h.worker.ready;
  const run = h.worker.request('run', { code: 'cf_takeoff()', timeoutMs: 20000 });
  await tick();
  const flightRequest = JSON.parse(h.input());
  const emergency = h.worker.request('emergency-stop');
  await tick();
  const request = JSON.parse(h.input());
  assert.equal(request.action, 'emergency-stop');
  h.emit({ type: 'result', id: request.id, result: { success: true } });
  assert.equal((await emergency).success, true);
  assert.equal(h.worker.running, true);
  assert.equal(h.launches, 1);
  const timeout = h.worker.request('emergency-stop');
  await tick();
  assert.equal(JSON.parse(h.input()).action, 'emergency-stop');
  t.mock.timers.tick(3001);
  assert.match((await timeout).message, /not verified/);
  assert.equal(h.worker.running, true);
  assert.equal(h.kills, 0);
  h.emit({ type: 'result', id: flightRequest.id, result: { success: false } });
  await run;
  h.close(0);
});

test('a mapping timeout reports failure without cancelling, disconnecting or finishing an active flight', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const h = workerAdapter();
  h.emit({ type: 'state', state: 'ready' });
  await h.worker.ready;
  const run = h.worker.request('run', { code: 'cf_takeoff()', timeoutMs: 20000 });
  await tick();
  const flight = JSON.parse(h.input().trim());
  const mapping = h.worker.request('mapping', { enabled: true });
  await tick();
  assert.match(h.input(), /mapping/);
  t.mock.timers.tick(8000);
  const result = await mapping;
  assert.equal(result.success, false);
  assert.match(result.message, /not cancelled/);
  assert.equal(h.worker.running, true);
  assert.equal(h.input(), '', 'mapping timeouts cannot send cancel or shutdown');
  h.emit({ type: 'result', id: flight.id, result: { success: true } });
  await run;
  h.close(0);
  assert.equal(h.kills, 0);
});

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

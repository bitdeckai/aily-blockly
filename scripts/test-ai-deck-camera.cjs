const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');
const { spawnSync } = require('node:child_process');
const ts = require('typescript');
const root = path.resolve(__dirname, '..');
const filename = path.join(root, 'src', 'app', 'editors', 'blockly-editor', 'components', 'blockly',
  'components', 'ai-deck-camera', 'ai-deck-camera.component.ts');
const loadData = require('./helpers/load-crazyflie-data.cjs');
const cameraProtocol = loadData(path.join(root, 'src', 'app', 'services', 'ai-deck-camera.ts'));
function harness() {
  const timers = new Map(), warnings = [], addresses = [];
  let next = 0;
  const exports = {};
  const schedule = callback => { timers.set(++next, callback); return next; };
  vm.runInNewContext(ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, experimentalDecorators: true },
  }).outputText, {
    exports, URL, console: { warn: (...args) => warnings.push(args) },
    setInterval: schedule, setTimeout: schedule,
    clearInterval: id => timers.delete(id), clearTimeout: id => timers.delete(id),
    require: name => name === '@angular/core' ? {
      Component: () => value => value, Input: () => () => {}, Output: () => () => {},
      ViewChild: () => () => {}, EventEmitter: class { emit(value) { addresses.push(value); } },
    } : name.endsWith('/ai-deck-camera') ? cameraProtocol : {},
  });
  return { ...exports, timers, warnings, addresses, camera: new exports.AiDeckCameraComponent() };
}

test('AI Deck accepts IPs, ports and explicit HTTP streams without navigation, unsafe protocols or embedded credentials', () => {
  const { aiDeckStreamUrl } = harness();
  assert.equal(aiDeckStreamUrl(' 192.168.4.1 '), 'http://192.168.4.1/stream');
  assert.equal(aiDeckStreamUrl('camera.local:8080'), 'http://camera.local:8080/stream');
  assert.equal(aiDeckStreamUrl('https://camera.local/video?quality=10'), 'https://camera.local/video?quality=10');
  for (const address of ['', ' ', 'not a host', 'file:///etc/passwd', 'ftp://camera/stream',
    'javascript:alert(1)', 'http://user:pass@camera/', 'http://camera/#fragment']) {
    assert.throws(() => aiDeckStreamUrl(address), address);
  }
});

test('AI Deck opens only on request, waits for decoded frames and releases every request/timer on disconnect or destroy', () => {
  const { camera, timers, addresses } = harness();
  assert.equal(camera.streamUrl, '');
  assert.equal(timers.size, 0);
  camera.address = '192.168.4.1';
  camera.connect();
  assert.equal(camera.state, 'connecting');
  assert.equal(camera.streamUrl, 'http://192.168.4.1/stream');
  assert.deepEqual(addresses, ['192.168.4.1']);
  camera.image = { nativeElement: {
    naturalWidth: 0,
    removeAttribute(name) { assert.equal(name, 'src'); this.naturalWidth = 0; },
  } };
  camera.checkFrame();
  assert.equal(camera.state, 'connecting', 'an HTTP response alone is not a decoded video frame');
  camera.image.nativeElement.naturalWidth = 320;
  camera.checkFrame();
  assert.equal(camera.state, 'connected');
  assert.equal(timers.size, 0);
  camera.disconnect();
  assert.equal(camera.streamUrl, '');
  assert.equal(camera.image.nativeElement.naturalWidth, 0, 'disconnect must explicitly abort the image, not just remove its DOM view');
  camera.connect();
  camera.checkFrame();
  assert.equal(camera.state, 'connecting', 'a previous decoded frame cannot make a new connection appear ready');
  assert.equal(timers.size, 2);
  camera.ngOnDestroy();
  assert.equal(camera.streamUrl, '');
  assert.equal(timers.size, 0);
});

test('AI Deck surfaces invalid addresses, failed streams and initial-frame timeout without silently claiming success', () => {
  const { camera, timers, warnings } = harness();
  camera.address = 'file:///camera';
  camera.connect();
  assert.equal(camera.state, 'error');
  assert.equal(camera.errorKey, 'AI_DECK_CAMERA.INVALID_ADDRESS');
  assert.equal(camera.streamUrl, '');
  camera.address = '192.168.4.1';
  camera.connect();
  camera.imageError();
  assert.equal(camera.errorKey, 'AI_DECK_CAMERA.STREAM_ERROR');
  camera.connect();
  Array.from(timers.values()).at(-1)();
  assert.equal(camera.state, 'error');
  assert.equal(camera.errorKey, 'AI_DECK_CAMERA.TIMEOUT');
  assert.equal(camera.streamUrl, '');
  assert.equal(timers.size, 0);
  assert.equal(warnings.length, 3);
});

test('AI Deck messages exist in every supported language and embedding does not use iframes or bypass sanitization', () => {
  const languages = JSON.parse(fs.readFileSync(path.join(root, 'public', 'i18n', 'i18n.json'), 'utf8'));
  const reference = JSON.parse(fs.readFileSync(path.join(root, 'public', 'i18n', 'en', 'en.json'), 'utf8')).AI_DECK_CAMERA;
  for (const { code } of languages) {
    const labels = JSON.parse(fs.readFileSync(path.join(root, 'public', 'i18n', code, `${code}.json`), 'utf8')).AI_DECK_CAMERA;
    for (const key of Object.keys(reference)) assert.ok(labels?.[key]?.trim(), `${code}: ${key}`);
  }
  const source = fs.readFileSync(filename, 'utf8');
  assert.doesNotMatch(source, /iframe|bypassSecurity|setMapping|runCode|commander/);
  assert.match(source, /referrerpolicy="no-referrer"/);
});

test('camera runtime events are strict and program commands drive the existing viewer in order', () => {
  const { camera, timers } = harness();
  for (const [command, state] of [
    [{ type: 'configure', address: '192.168.4.1' }, 'idle'],
    [{ type: 'open' }, 'connecting'],
    [{ type: 'close' }, 'idle'],
  ]) {
    const parsed = cameraProtocol.parseAiDeckCameraEvent(`__AIDECK__:${JSON.stringify(command)}`);
    camera.command = parsed;
    camera.ngOnChanges({ command: {} });
    assert.equal(camera.state, state);
  }
  assert.equal(timers.size, 0);
  assert.equal(camera.address, '192.168.4.1');
  for (const event of ['__AIDECK__:null', '__AIDECK__:{"type":"open-flight"}',
    '__AIDECK__:{"type":"configure","address":"file:///bad"}']) {
    assert.throws(() => cameraProtocol.parseAiDeckCameraEvent(event));
  }
  assert.equal(cameraProtocol.parseAiDeckCameraEvent('ordinary device log'), undefined);
});

test('camera service never reconnects when merely reopening its panel, but repeats explicit open requests', () => {
  const exports = {};
  const filename = path.join(root, 'src', 'app', 'services', 'ai-deck-camera.service.ts');
  vm.runInNewContext(ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, experimentalDecorators: true },
  }).outputText, { exports, require: name =>
    name === '@angular/core' ? { Injectable: () => value => value }
      : name.endsWith('/ai-deck-camera') ? cameraProtocol : require(name) });
  const service = new exports.AiDeckCameraService();
  service.showPanel();
  assert.equal(service.command$.value, null);
  assert.throws(() => service.execute({ type: 'open' }), /INVALID_ADDRESS/);
  service.execute({ type: 'configure', address: '192.168.4.1' });
  const commands = [];
  const subscription = service.command$.subscribe(command => commands.push(command?.type));
  service.execute({ type: 'open' });
  service.execute({ type: 'open' });
  assert.deepEqual(commands, ['configure', 'open', 'open']);
  service.hidePanel();
  assert.equal(service.visible$.value, false);
  assert.equal(service.command$.value, null);
  service.showPanel();
  assert.equal(service.command$.value, null);
  assert.equal(service.address$.value, '192.168.4.1');
  subscription.unsubscribe();
});

test('Python emits ordered host camera events and step indices, handles cancellation and validates before loading hardware', () => {
  const result = spawnSync('py', ['-3', '-B', '-c', `
import io, json, runpy, sys, types
from pathlib import Path
from threading import Event
from contextlib import redirect_stdout
ns = runpy.run_path(str(Path('child') / 'scripts' / 'crazyflie_run_flow.py'), run_name='camera_test')
code = 'cf_ai_deck_config("192.168.4.1")\\ncf_ai_deck_open()\\ncf_delay(0)\\ncf_ai_deck_close()'
commands = ns['parse_commands'](code)
assert [arg['type'] for cmd, arg in commands if cmd == 'ai_deck'] == ['configure', 'open', 'close']
for bad in ['cf_ai_deck_open()', 'cf_ai_deck_config("ftp://camera/stream")', 'cf_ai_deck_open(1)', 'cf_ai_deck_fake()']:
    try:
        ns['run_flow']('radio://0/80/2M', ns['parse_commands'](bad), None)
    except (ValueError, SyntaxError):
        pass
    else:
        raise AssertionError(bad)
modules = {}
for name in ['cflib', 'cflib.crtp', 'cflib.crazyflie', 'cflib.crazyflie.syncCrazyflie',
             'cflib.crazyflie.log', 'cflib.crazyflie.syncLogger', 'cflib.positioning',
             'cflib.positioning.motion_commander', 'cflib.utils', 'cflib.utils.multiranger']:
    modules[name] = sys.modules[name] = types.ModuleType(name)
    if '.' in name:
        parent, attr = name.rsplit('.', 1)
        setattr(modules[parent], attr, modules[name])
def forbidden(*args, **kwargs):
    raise AssertionError('Camera-only flow must not connect, scan or control motors')
for name, attr in [('cflib.crazyflie.syncCrazyflie', 'SyncCrazyflie'),
                   ('cflib.crazyflie.log', 'LogConfig'), ('cflib.crazyflie.syncLogger', 'SyncLogger'),
                   ('cflib.positioning.motion_commander', 'MotionCommander'), ('cflib.utils.multiranger', 'Multiranger')]:
    setattr(modules[name], attr, forbidden)
modules['cflib.crtp'].init_drivers = lambda **kwargs: None
output = io.StringIO()
with redirect_stdout(output):
    result = ns['run_flow']('radio://0/80/2M', commands, None)
assert result['success'], result
lines = output.getvalue().splitlines()
events = [json.loads(line[len('__AIDECK__:'):])['type'] for line in lines if line.startswith('__AIDECK__:')]
assert events == ['configure', 'open', 'close'], lines
assert [line.split(':', 2)[1] for line in lines if line.startswith('__STEP__:')] == ['1/4', '2/4', '3/4', '4/4'], lines
stop = Event()
stop.set()
with redirect_stdout(io.StringIO()) as output:
    try:
        ns['run_flow']('radio://0/80/2M', commands, None, stop_requested=stop)
    except RuntimeError as error:
        assert 'cancelled' in str(error), error
    else:
        raise AssertionError('Cancelled flow continued')
assert '__AIDECK__:' not in output.getvalue()
`], { cwd: root, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr || result.stdout);
});

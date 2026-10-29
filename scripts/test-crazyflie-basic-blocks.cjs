const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { spawnSync } = require('node:child_process');
const { test, afterEach } = require('node:test');
const ts = require('typescript');
const Blockly = require('blockly');
const zh = require('blockly/msg/zh-hans');

require.extensions['.ts'] = (module, filename) => {
  const { outputText } = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    fileName: filename,
  });
  module._compile(outputText, filename);
};
const root = path.resolve(__dirname, '..');
const source = path.join(root, 'src', 'app', 'editors', 'blockly-editor', 'components', 'blockly', 'generators', 'crazyflie');
const { createCrazyflieBasicToolbox, registerCrazyflieBasicBlocks, crazyflieGenerator } =
  require(path.join(source, 'basic-blocks.ts'));
const { compileCrazyflieFlow } = require(path.join(source, 'compile-flow.ts'));
const { CRAZYFLIE_EXAMPLES, createCrazyflieExample } = require(path.join(source, 'examples.ts'));
const radio = require(path.join(source, 'radio-blocks.ts'));
const {
  registerCrazyflieMotionBlocks, createCrazyflieMotionToolbox, parseMotionCall, validateMotionCommand,
  motionDurationSeconds, motionFlowTimeoutMs,
} = require(path.join(source, 'motion-blocks.ts'));

Blockly.setLocale(zh);
const categories = createCrazyflieBasicToolbox(true);
registerCrazyflieBasicBlocks();
registerCrazyflieMotionBlocks(crazyflieGenerator, true);
Blockly.defineBlocksWithJsonArray(JSON.parse(fs.readFileSync(path.join(root, 'child', 'boards',
  'board-crazyflie', 'template', 'node_modules', '@aily-project', 'lib-crazyflie-motion', 'block.json'), 'utf8')));
vm.runInNewContext(fs.readFileSync(path.join(root, 'child', 'boards', 'board-crazyflie', 'template',
  'node_modules', '@aily-project', 'lib-crazyflie-motion', 'generator.js'), 'utf8'), {
  window: { MPY: crazyflieGenerator },
});
radio.registerCrazyradioBlocks(crazyflieGenerator, true);

const workspaces = [];
function workspace(blocks, variables = []) {
  const result = new Blockly.Workspace();
  workspaces.push(result);
  Blockly.serialization.workspaces.load({ blocks: { languageVersion: 0, blocks }, variables }, result);
  return result;
}
const value = n => ({ block: { type: 'math_number', fields: { NUM: n } } });
const string = text => ({ block: { type: 'text', fields: { TEXT: text } } });
const variable = () => ({ block: { type: 'variables_get', fields: { VAR: { id: 'n' } } } });
const print = input => ({ type: 'text_print', inputs: { TEXT: input } });
const flight = type => ({ type });
const chain = (...blocks) => blocks.reduceRight((next, block) =>
  next ? { ...block, next: { block: next } } : block, null);
const compile = ws => compileCrazyflieFlow(ws, crazyflieGenerator);

afterEach(() => {
  workspaces.splice(0).forEach(ws => ws.dispose());
});

test('six categories contain defined blocks with Python generators', () => {
  assert.deepEqual(categories.map(category => category.name), ['逻辑', '循环', '数学', '文字', '时间', '变量']);
  assert.equal(categories.at(-1).custom, 'VARIABLE');
  for (const category of categories) {
    for (const info of category.contents) {
      const ws = workspace([{ type: info.type, inputs: info.inputs }]);
      assert.doesNotThrow(() => crazyflieGenerator.workspaceToCode(ws), info.type);
    }
  }
  assert.deepEqual(createCrazyflieBasicToolbox(false).map(category => category.name),
    ['Logic', 'Loops', 'Math', 'Text', 'Time', 'Variables']);
});

test('legacy straight-line flight still generates valid Python', () => {
  const ws = workspace([chain(flight('cf_takeoff'), flight('cf_land'))]);
  const code = compile(ws);
  assert.match(code, /cf_takeoff\(\)/);
  assert.match(code, /cf_land\(\)/);
  assert.doesNotMatch(code, /while True/);
});

test('basic example list compiles exact self-test and flight plans with deliberate waits', () => {
  assert.deepEqual(CRAZYFLIE_EXAMPLES.map(example => example.id), ['self-test', 'hover', 'back-and-forth', 'square']);
  const expected = {
    'self-test': ['cf_test_link()', 'cf_delay(2)', 'cf_crazyflie_link()', 'cf_delay(2)',
      'cf_test_crazyflie_link()', 'cf_delay(3)'],
    hover: ['cf_crazyflie_link()', 'cf_delay(2)', 'cf_motion("takeoff", [0.3, 0.2])',
      'cf_delay(3)', 'cf_motion("land", [0.2])', 'cf_delay(2)'],
    'back-and-forth': ['cf_crazyflie_link()', 'cf_delay(2)', 'cf_motion("takeoff", [0.3, 0.2])', 'cf_delay(2)',
      'cf_motion("move", [0.3, 0, 0, 0.2])', 'cf_delay(1)', 'cf_motion("move", [-0.3, 0, 0, 0.2])',
      'cf_delay(1)', 'cf_motion("land", [0.2])', 'cf_delay(2)'],
    square: ['cf_crazyflie_link()', 'cf_delay(2)', 'cf_motion("takeoff", [0.3, 0.2])', 'cf_delay(2)',
      'cf_motion("move", [0.3, 0, 0, 0.2])', 'cf_delay(1)', 'cf_motion("move", [0, 0.3, 0, 0.2])', 'cf_delay(1)',
      'cf_motion("move", [-0.3, 0, 0, 0.2])', 'cf_delay(1)', 'cf_motion("move", [0, -0.3, 0, 0.2])', 'cf_delay(1)',
      'cf_motion("land", [0.2])', 'cf_delay(2)'],
  };
  const sim = simulator();
  for (const example of CRAZYFLIE_EXAMPLES) {
    const state = createCrazyflieExample(example.id);
    const original = JSON.stringify(state);
    const ws = workspace([state]);
    assert.deepEqual(JSON.parse(JSON.stringify(sim.parseCommands(compile(ws)))),
      JSON.parse(JSON.stringify(sim.parseCommands(expected[example.id].join('\n')))), example.id);
    assert.equal(JSON.stringify(state), original, 'loading cannot mutate reusable example data');
    const restored = workspace([]);
    Blockly.serialization.workspaces.load(Blockly.serialization.workspaces.save(ws), restored);
    assert.equal(compile(restored), compile(ws), 'saving and reopening must keep the delays and values');
    assert.notEqual(createCrazyflieExample(example.id), state, 'each insertion must have fresh state');
  }
  assert.throws(() => createCrazyflieExample('unknown'), /Unknown Crazyflie example/);
});

test('all Settings languages include example names, instructions and explicit motor warnings', () => {
  const languages = JSON.parse(fs.readFileSync(path.join(root, 'public', 'i18n', 'i18n.json'), 'utf8'));
  const keys = [...CRAZYFLIE_EXAMPLES.flatMap(example => [example.titleKey, example.descriptionKey]),
    ...['MENU', 'SELF_TEST_NOTICE', 'FLIGHT_NOTICE', 'BUSY', 'ERROR'].map(key => `CRAZYFLIE_EXAMPLES.${key}`),
    'CRAZYFLIE_TOOLBOX.UNAVAILABLE'];
  for (const { code } of languages) {
    const data = JSON.parse(fs.readFileSync(path.join(root, 'public', 'i18n', code, `${code}.json`), 'utf8'));
    for (const key of keys) {
      const value = key.split('.').reduce((value, part) => value?.[part], data);
      assert.equal(typeof value, 'string', `${code}: ${key}`);
      assert.ok(value.trim());
    }
    if (code === 'zh_cn') assert.match(data.CRAZYFLIE_EXAMPLES.SELF_TEST_NOTICE, /驱动电机.*拆下螺旋桨/);
    if (code === 'en') assert.match(data.CRAZYFLIE_EXAMPLES.SELF_TEST_NOTICE, /motors.*remove the propellers/);
  }
});

test('Crazyradio parameters generate addressed official URIs and round-trip saved blocks', () => {
  for (const rate of ['250K', '1M', '2M']) {
    const ws = workspace([chain(
      { type: 'cf_radio_config', fields: { RADIO: 0, CHANNEL: 42, RATE: rate, ADDRESS: '0xABCDEF1234' } },
      flight('cf_test_link'), flight('cf_scan_links'),
    )]);
    const code = compile(ws);
    assert.match(code, new RegExp(`cf_set_link\\("radio://0/42/${rate}/ABCDEF1234", "ABCDEF1234"\\)`));
    assert.match(code, /cf_test_link\(\)/);
    assert.match(code, /cf_scan_links\(\)/);
    const restored = workspace([]);
    Blockly.serialization.workspaces.load(Blockly.serialization.workspaces.save(ws), restored);
    assert.equal(compile(restored), code);
  }
  const uri = workspace([{ type: 'cf_link_config', fields: {
    URI: 'radio://0/80/2M/E7E7E7E7E7?safelink=1', ADDRESS: 'ABCDEF1234',
  } }]);
  assert.match(compile(uri), /radio:\/\/0\/80\/2M\/ABCDEF1234\?safelink=1/);
  const restoredUri = workspace([]);
  Blockly.serialization.workspaces.load(Blockly.serialization.workspaces.save(uri), restoredUri);
  assert.equal(compile(restoredUri), compile(uri), 'hidden legacy URI blocks still round-trip');
  for (const fields of [{ ADDRESS: 'bad' }, { URI: 'radio://0/999/2M' }, { URI: 'usb://0' }]) {
    assert.throws(() => compile(workspace([{ type: 'cf_link_config', fields }])), /Crazyradio/);
  }
});

test('Crazyradio toolbox hides the legacy URI block and uses wireless transceiver terminology', () => {
  const toolbox = radio.createCrazyradioToolbox();
  assert.deepEqual(toolbox.contents.map(block => block.type),
    ['cf_test_link', 'cf_scan_links', 'cf_radio_config']);
  const ws = workspace(toolbox.contents);
  assert.equal(ws.getBlocksByType('cf_test_link')[0].toString(), '检测无线收发器');
  assert.match(ws.getBlocksByType('cf_radio_config')[0].toString(), /^无线收发器 0 信道 80 速率 2M/);
  for (const block of ws.getAllBlocks(false)) {
    assert.doesNotMatch(block.toString(), /电台/);
    assert.doesNotMatch(block.getTooltip(), /电台/);
  }
  assert.ok(Blockly.Blocks['cf_link_config']);
  assert.equal(typeof crazyflieGenerator.forBlock['cf_link_config'], 'function');
});

test('radio scans run only in the initial radio prefix and simulation never invents hardware results', async () => {
  const sim = simulator();
  const code = compile(workspace([chain(flight('cf_radio_config'), flight('cf_test_link'), flight('cf_scan_links'))]));
  const result = await sim.runCode(code);
  assert.equal(result.success, true, result.message);
  assert.equal(result.executed.at(-1), 'scan_links');
  assert.ok(sim.logs$.value.some(line => line.includes('no radio scan')));
  const invalid = workspace([chain(flight('cf_crazyflie_link'), flight('cf_scan_links'))]);
  assert.throws(() => compile(invalid), /before connecting/);
  await assert.rejects(sim.runCode('cf_crazyflie_link()\ncf_scan_links()'), /before connecting/);
});

test('Python radio prefix scans the selected radio before connecting, closes it on errors and cancellation, and never starts motors', () => {
  const python = process.platform === 'win32' ? 'py' : 'python3';
  const args = process.platform === 'win32' ? ['-3'] : [];
  const result = spawnSync(python, [...args, '-B', '-c', `
import io, runpy, sys, types
from threading import Event
from pathlib import Path
from contextlib import redirect_stdout
ns = runpy.run_path(str(Path('child') / 'scripts' / 'crazyflie_run_flow.py'), run_name='radio_test')
modules = {}
for name in ['cflib', 'cflib.crtp', 'cflib.crazyflie', 'cflib.crazyflie.syncCrazyflie',
             'cflib.crazyflie.log', 'cflib.crazyflie.syncLogger', 'cflib.positioning',
             'cflib.positioning.motion_commander', 'cflib.crtp.radiodriver',
             'cflib.utils', 'cflib.utils.multiranger', 'cflib.drivers', 'cflib.drivers.crazyradio']:
    module = types.ModuleType(name)
    modules[name] = sys.modules[name] = module
    if '.' in name:
        parent, attr = name.rsplit('.', 1)
        setattr(modules[parent], attr, module)
calls = []
mode = ['found']
serials = ['1798949C5F', 'AABBCCDD0002', '001122334455']
opened = []
stop = Event()
class Connection:
    def __init__(self, uri):
        assert all(radio.closed for radio in opened), 'scan did not release the radio before connecting'
        calls.append(('connect', uri))
        self.cf = types.SimpleNamespace()
    def __enter__(self): return self
    def __exit__(self, *args): pass
def forbidden(*args, **kwargs):
    raise AssertionError('motor or motion API called during radio scan')
class Radio:
    DR_250KPS, DR_1MPS, DR_2MPS = 0, 1, 2
    version = 0.53
    def __init__(self, index):
        self.index, self.closed = index, False
        opened.append(self)
    def set_address(self, address): self.address = address
    def set_arc(self, arc): assert arc == 1
    def set_data_rate(self, rate): self.rate = rate
    def scan_channels(self, start, end, packet):
        assert (start, end, packet) == (0, 125, (0xff,))
        assert self.address == tuple(bytes.fromhex('ABCDEF1234'))
        assert not any(call[0] == 'connect' for call in calls), calls
        calls.append(('scan', self.index, self.rate))
        if mode[0] == 'error': raise RuntimeError('USB scan failed')
        if mode[0] == 'cancel': stop.set()
        return [42] if mode[0] == 'found' and self.rate == 2 else []
    def close(self): self.closed = True
class Driver:
    @staticmethod
    def parse_uri(uri):
        radio_id = uri.split('/')[2]
        return (int(radio_id) if len(radio_id) < 10 and radio_id.isdigit() else serials.index(radio_id.upper()),)
modules['cflib.crtp'].init_drivers = lambda **kwargs: None
modules['cflib.crtp'].scan_interfaces = forbidden
modules['cflib.crazyflie.syncCrazyflie'].SyncCrazyflie = Connection
modules['cflib.crazyflie.log'].LogConfig = forbidden
modules['cflib.crazyflie.syncLogger'].SyncLogger = forbidden
modules['cflib.positioning.motion_commander'].MotionCommander = forbidden
modules['cflib.crtp.radiodriver'].RadioDriver = Driver
modules['cflib.crtp.radiodriver'].RadioManager = types.SimpleNamespace(open=Radio)
modules['cflib.drivers.crazyradio'].Crazyradio = Radio
modules['cflib.utils.multiranger'].Multiranger = forbidden
code = 'cf_set_link("radio://0/42/2M/ABCDEF1234", "ABCDEF1234")\\ncf_test_link()\\ncf_scan_links()'
commands = ns['parse_commands'](code)
assert [cmd for cmd, _ in commands] == ['set_link', 'test_link', 'scan_links']
for state in ['found', 'empty', 'error', 'cancel']:
    mode[0] = state
    calls.clear()
    output = io.StringIO()
    stop.clear()
    try:
        with redirect_stdout(output):
            result = ns['run_flow']('radio://0/80/2M', commands, 'E7E7E7E7E7', stop_requested=stop)
    except RuntimeError as error:
        assert (state == 'error' and 'RADIO_SCAN_FAILED' in str(error)
                or state == 'cancel' and 'cancelled' in str(error)), error
    else:
        assert state in ('found', 'empty')
        assert result['success'], result
        assert result['addressHex'] == 'ABCDEF1234'
        assert result['uri'] == 'radio://0/42/2M/ABCDEF1234'
        assert result['executed'][-1] == 'scan_links'
        assert len(result['links']) == (1 if state == 'found' else 0)
    assert calls == [('scan', 0, rate) for rate in range(1 if state in ('error', 'cancel') else 3)], calls
    assert all(radio.closed for radio in opened)
mode[0] = 'found'
for radio_id in ['1798949C5F', '1', 'AABBCCDD0002', '001122334455']:
    calls.clear()
    uri = f'radio://{radio_id}/42/2M/ABCDEF1234'
    with redirect_stdout(io.StringIO()):
        result = ns['run_flow'](uri, commands[1:], 'ABCDEF1234')
    index = Driver.parse_uri(uri)[0]
    assert calls == [('scan', index, rate) for rate in range(3)], calls
    assert result['links'] == [f'radio://{radio_id}/42/2M/ABCDEF1234'], result
    assert all(radio.closed for radio in opened)
serials.reverse()
calls.clear()
with redirect_stdout(io.StringIO()):
    result = ns['run_flow']('radio://1798949C5F/42/2M/ABCDEF1234', commands[1:], 'ABCDEF1234')
assert calls == [('scan', 2, rate) for rate in range(3)], calls
assert result['links'] == ['radio://1798949C5F/42/2M/ABCDEF1234'], result
calls.clear()
with redirect_stdout(io.StringIO()):
    try:
        ns['run_flow']('radio://DEADBEEF0000/42/2M/ABCDEF1234', commands[1:], 'ABCDEF1234')
    except RuntimeError as error:
        assert 'TEST_RADIO_FAILED' in str(error), error
    else:
        raise AssertionError('missing selected radio accepted')
assert not calls
calls.clear()
with redirect_stdout(io.StringIO()):
    result = ns['run_flow']('radio://0/80/2M', commands + [('crazyflie_link', None)], 'E7E7E7E7E7')
assert calls[:3] == [('scan', 0, rate) for rate in range(3)], calls
assert len(calls) > 3 and all(call[0] == 'connect' for call in calls[3:]), calls
calls.clear()
try:
    ns['run_flow']('radio://0/80/2M', [('crazyflie_link', None), ('scan_links', None)], 'E7E7E7E7E7')
except ValueError: pass
else: raise AssertionError('scan after connecting accepted')
assert not calls
print('radio prefix passed without motor access')
`], { cwd: root, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
});

test('hidden legacy delay and print blocks still deserialize and compile from old projects', () => {
  const original = workspace([chain(flight('cf_delay'), flight('cf_print_text'), flight('cf_print'))]);
  const restored = workspace([]);
  Blockly.serialization.workspaces.load(Blockly.serialization.workspaces.save(original), restored);
  const code = compile(restored);
  assert.equal(code, compile(original));
  assert.match(code, /cf_delay\(/);
  assert.equal((code.match(/cf_print\(/g) || []).length, 2);
});

test('repeat expands flight calls and preserves repeated highlight targets', () => {
  const ws = workspace([{
    type: 'controls_repeat_ext', inputs: {
      TIMES: value(3), DO: { block: flight('cf_move_forward') },
    },
  }]);
  const ids = [];
  const code = compileCrazyflieFlow(ws, crazyflieGenerator, block => ids.push(block.id));
  assert.equal((code.match(/cf_move\('forward', 0.5\)/g) || []).length, 3);
  assert.equal(ids.length, 3);
  assert.equal(new Set(ids).size, 1);
  assert.doesNotMatch(code, /for |range\(/);
});

test('variables, arithmetic, conditions and print resolve before flight', () => {
  const ws = workspace([chain(
    { type: 'variables_set', fields: { VAR: { id: 'n' } }, inputs: { VALUE: value(2) } },
    { type: 'math_change', fields: { VAR: { id: 'n' } }, inputs: { DELTA: value(3) } },
    {
      type: 'controls_if', inputs: {
        IF0: { block: { type: 'logic_compare', fields: { OP: 'EQ' }, inputs: { A: variable(), B: value(5) } } },
        DO0: { block: chain(print(variable()), flight('cf_land')) },
      },
    },
  )], [{ name: 'n', id: 'n' }]);
  const code = compile(ws);
  assert.match(crazyflieGenerator.workspaceToCode(ws), /n = 2/);
  assert.match(code, /cf_print\("5"\)/);
  assert.match(code, /cf_land\(\)/);
  assert.doesNotMatch(code, /if | = /);
});

test('false branch does not execute flight commands', () => {
  const ws = workspace([{
    type: 'controls_if', extraState: { hasElse: true }, inputs: {
      IF0: { block: { type: 'logic_boolean', fields: { BOOL: 'FALSE' } } },
      DO0: { block: flight('cf_takeoff') },
      ELSE: { block: print(string('stayed on ground')) },
    },
  }]);
  assert.equal(compile(ws).trim(), 'cf_print("stayed on ground")');
});

test('counting loop handles descending ranges', () => {
  const ws = workspace([{
    type: 'controls_for', fields: { VAR: { id: 'n' } }, inputs: {
      FROM: value(3), TO: value(1), BY: value(1), DO: { block: print(variable()) },
    },
  }], [{ name: 'n', id: 'n' }]);
  assert.deepEqual(compile(ws).trim().split('\n'), ['cf_print("3")', 'cf_print("2")', 'cf_print("1")']);
});

test('while loops update variables and stop at their condition', () => {
  const ws = workspace([chain(
    { type: 'variables_set', fields: { VAR: { id: 'n' } }, inputs: { VALUE: value(0) } },
    {
      type: 'controls_whileUntil', fields: { MODE: 'WHILE' }, inputs: {
        BOOL: { block: { type: 'logic_compare', fields: { OP: 'LT' }, inputs: { A: variable(), B: value(2) } } },
        DO: { block: chain(print(variable()), {
          type: 'math_change', fields: { VAR: { id: 'n' } }, inputs: { DELTA: value(1) },
        }) },
      },
    },
  )], [{ name: 'n', id: 'n' }]);
  assert.deepEqual(compile(ws).trim().split('\n'), ['cf_print("0")', 'cf_print("1")']);
});

test('break ends only the enclosing loop', () => {
  const ws = workspace([chain({
    type: 'controls_repeat_ext', inputs: {
      TIMES: value(5),
      DO: { block: chain(print(string('once')), { type: 'controls_flow_statements', fields: { FLOW: 'BREAK' } }) },
    },
  }, print(string('after')))]);
  assert.deepEqual(compile(ws).trim().split('\n'), ['cf_print("once")', 'cf_print("after")']);
});

test('text operations and delay accept calculated input values', () => {
  const ws = workspace([chain(
    print({ block: { type: 'text_join', extraState: { itemCount: 2 }, inputs: { ADD0: string('高度：'), ADD1: value(3) } } }),
    {
      type: 'cf_core_delay', inputs: {
        SECONDS: { block: { type: 'math_arithmetic', fields: { OP: 'DIVIDE' }, inputs: { A: value(1), B: value(2) } } },
      },
    },
  )]);
  assert.equal(compile(ws).trim(), 'cf_print("高度：3")\ncf_delay(0.500000)');
});

test('disabled stacks are skipped without dropping enabled following blocks', () => {
  const ws = workspace([chain(
    { type: 'text_print', inputs: { TEXT: string('skip') } },
    print(string('keep')),
  )]);
  ws.getTopBlocks(false)[0].setDisabledReason(true, 'test');
  assert.equal(compile(ws).trim(), 'cf_print("keep")');
});

test('unbounded loops, zero steps and invalid arithmetic fail before any flight', () => {
  const ws = workspace([chain(flight('cf_takeoff'), {
    type: 'controls_whileUntil', fields: { MODE: 'WHILE' },
    inputs: { BOOL: { block: { type: 'logic_boolean', fields: { BOOL: 'TRUE' } } } },
  })]);
  assert.throws(() => compile(ws), /10000/);
  const zeroStep = workspace([{
    type: 'controls_for', inputs: { FROM: value(1), TO: value(2), BY: value(0) },
  }]);
  assert.throws(() => compile(zeroStep), /步长/);
  const divide = workspace([print({
    block: { type: 'math_arithmetic', fields: { OP: 'DIVIDE' }, inputs: { A: value(1), B: value(0) } },
  })]);
  assert.throws(() => compile(divide), /有限数值/);
});

test('live sensor conditions are explicitly rejected instead of executing both branches', () => {
  const ws = workspace([{
    type: 'controls_if', inputs: {
      IF0: { block: { type: 'cf_mr_has_obstacle' } }, DO0: { block: flight('cf_takeoff') },
    },
  }]);
  assert.throws(() => compile(ws), /实时传感器/);
});

test('saved basic blocks and variables can be reloaded', () => {
  const original = workspace([chain(
    { type: 'variables_set', fields: { VAR: { id: 'n' } }, inputs: { VALUE: value(7) } },
    print(variable()),
  )], [{ name: 'n', id: 'n' }]);
  const expected = compile(original);
  const restored = workspace([]);
  Blockly.serialization.workspaces.load(Blockly.serialization.workspaces.save(original), restored);
  assert.equal(compile(restored), expected);
});

test('the 10000-step expansion limit accepts the boundary and rejects the next step', () => {
  const atLimit = workspace([{ type: 'controls_repeat_ext', inputs: { TIMES: value(9998) } }]);
  assert.equal(compile(atLimit), '');
  atLimit.getTopBlocks(false)[0].getInputTargetBlock('TIMES').setFieldValue(9999, 'NUM');
  assert.throws(() => compile(atLimit), /10000/);
});

test('the real-flight parser accepts the compiled plan and preserves Unicode printing', () => {
  const ws = workspace([chain(
    {
      type: 'controls_repeat_ext', inputs: {
        TIMES: value(2),
        DO: { block: chain(print(string('高度：3\\n')), { type: 'cf_core_delay', inputs: { SECONDS: value(0.5) } }) },
      },
    },
    flight('cf_land'),
  )]);
  const code = compile(ws);
  const python = process.platform === 'win32' ? 'py' : 'python3';
  const args = process.platform === 'win32' ? ['-3'] : [];
  const result = spawnSync(python, [...args, '-B', '-c', `
import ast, json, runpy, sys
code = sys.stdin.buffer.read().decode('utf-8')
ast.parse(code)
from pathlib import Path
ns = runpy.run_path(str(Path('child') / 'scripts' / 'crazyflie_run_flow.py'), run_name='flow_test')
commands = ns['parse_commands'](code)
assert [command for command, value in commands] == ['print', 'delay', 'print', 'delay', 'land']
assert commands[1][1] == 0.5
assert ns['_normalize_print_value'](commands[0][1]) == '\\u9ad8\\u5ea6\\uff1a3\\\\n'
print(json.dumps(commands, ensure_ascii=True))
`], { cwd: root, input: code, encoding: 'utf8' });
  assert.equal(result.error, undefined, 'Python 3 is required for the flight-parser regression test');
  assert.equal(result.status, 0, result.stderr);
});

function simulator() {
  const { outputText } = ts.transpileModule(fs.readFileSync(path.join(root, 'src', 'app', 'services',
    'crazyflie-sim.service.ts'), 'utf8'), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, experimentalDecorators: true,
    },
  });
  const exports = {};
  vm.runInNewContext(outputText, {
    exports,
    require: name => name === '@angular/core' ? { Injectable: () => type => type }
      : name.endsWith('/crazyflie-classroom') ? require(path.join(root, 'src', 'app', 'services', 'crazyflie-classroom.ts'))
      : name.endsWith('/crazyflie-exploration') ? require(path.join(root, 'src', 'app', 'services', 'crazyflie-exploration.ts'))
      : name.endsWith('/crazyflie-attitude') ? require(path.join(root, 'src', 'app', 'services', 'crazyflie-attitude.ts'))
      : name.endsWith('/motion-blocks') ? require(path.join(source, 'motion-blocks.ts'))
      : name.endsWith('/radio-blocks') ? radio : require(name),
    setTimeout, clearTimeout, console,
  });
  return new exports.CrazyflieSimService({ setDeckDetected() {} });
}

test('classroom initial, reset and run poses place the drone at horizontal origin without changing height or other presets', async () => {
  const sim = simulator();
  const { getClassroomDeskLayout } = require(path.join(root, 'src', 'app', 'services', 'crazyflie-classroom.ts'));
  const helipad = () => getClassroomDeskLayout().helipadPose;
  assert.deepEqual(sim.pose$.value, helipad());
  assert.deepEqual({ ...sim.pose$.value }, { x: 0, y: 0.76573, z: 0, yaw: 0 });
  sim.pose$.next({ x: -1, y: 2, z: 1, yaw: 1 });
  sim.resetPose();
  assert.deepEqual(sim.pose$.value, helipad());
  sim.roomSize$.next({ width: 30, depth: 25, height: 5 });
  sim.resetPose();
  assert.deepEqual(sim.pose$.value, helipad());
  const result = await sim.runCode('cf_print("helipad")');
  assert.equal(result.success, true, result.message);
  assert.deepEqual(sim.pose$.value, helipad());
  for (const preset of ['home', 'custom']) {
    sim.setRoomPreset(preset);
    assert.deepEqual({ ...sim.pose$.value }, { x: 0, y: 0.06, z: 0, yaw: 0 });
  }
  sim.setRoomPreset('classroom');
  assert.deepEqual(sim.pose$.value, helipad());
});

test('simulation executes the expanded branch and decodes printed text exactly', async () => {
  const sim = simulator();
  const ws = workspace([{
    type: 'controls_repeat_ext', inputs: {
      TIMES: value(2), DO: { block: print(string('高度：3\\n')) },
    },
  }]);
  const result = await sim.runCode(compile(ws));
  assert.equal(result.success, true, result.message);
  assert.equal(sim.logs$.value.filter(line => line.includes('高度：3\\n')).length, 2);
});

test('simulated self-test stays on its step until the estimated test ends, then starts the separate delay', async () => {
  const sim = simulator();
  const waits = [];
  const steps = [];
  let finishSelfTest;
  const pendingSelfTest = new Promise(resolve => { finishSelfTest = resolve; });
  sim.waitWithControl = async (ms, speedAware) => {
    waits.push([ms, speedAware]);
    if (ms === 5000) await pendingSelfTest;
  };
  const subscription = sim.step$.subscribe(step => { if (step) steps.push(step.current); });
  try {
    const pending = sim.runCode('cf_test_crazyflie_link()\ncf_delay(3)');
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(waits, [[5000, true]]);
    assert.deepEqual(steps, [1]);
    assert.match(sim.logs$.value.at(-1), /simulation only, no firmware result/);
    finishSelfTest();
    const result = await pending;
    assert.equal(result.success, true);
    assert.deepEqual(waits, [[5000, true], [3000, false]]);
    assert.deepEqual(steps, [1, 2]);
    assert.deepEqual(Array.from(result.executed), ['test_crazyflie_link', 'delay:3']);
  } finally {
    finishSelfTest();
    subscription.unsubscribe();
  }
});

test('eight motion block templates generate valid commands and preserve saved inputs', () => {
  const toolbox = createCrazyflieMotionToolbox(true);
  assert.equal(toolbox.contents.length, 8);
  for (const info of toolbox.contents) {
    const ws = workspace([{ type: info.type, inputs: info.inputs }]);
    assert.ok(parseMotionCall(crazyflieGenerator.workspaceToCode(ws).trim()), info.type);
    const restored = workspace([]);
    Blockly.serialization.workspaces.load(Blockly.serialization.workspaces.save(ws), restored);
    assert.equal(crazyflieGenerator.workspaceToCode(restored), crazyflieGenerator.workspaceToCode(ws));
  }
});

test('motion inputs accept variables and arithmetic, and repeated calls retain highlight order', () => {
  const ws = workspace([chain(
    { type: 'variables_set', fields: { VAR: { id: 'n' } }, inputs: { VALUE: value(0.4) } },
    flight('cf_crazyflie_link'),
    { type: 'cf_takeoff_at', inputs: { HEIGHT: value(0.6), SPEED: value(0.2) } },
    {
      type: 'controls_repeat_ext', inputs: {
        TIMES: value(2), DO: { block: {
          type: 'cf_move_at_speed', fields: { DIRECTION: 'right' }, inputs: {
            DISTANCE: variable(),
            SPEED: { block: { type: 'math_arithmetic', fields: { OP: 'DIVIDE' }, inputs: { A: value(1), B: value(5) } } },
          },
        } },
      },
    },
    { type: 'cf_land_at_speed', inputs: { SPEED: value(0.1) } },
  )], [{ name: 'n', id: 'n' }]);
  const targets = [];
  const code = compileCrazyflieFlow(ws, crazyflieGenerator, block => targets.push(block.type));
  const commands = code.split('\n').filter(line => line.startsWith('cf_motion')).map(parseMotionCall);
  assert.deepEqual(commands, [
    { kind: 'takeoff', values: [0.6, 0.2] },
    { kind: 'move', values: [0, -0.4, 0, 0.2] },
    { kind: 'move', values: [0, -0.4, 0, 0.2] },
    { kind: 'land', values: [0.1] },
  ]);
  assert.deepEqual(targets, ['cf_crazyflie_link', 'cf_takeoff_at', 'cf_move_at_speed', 'cf_move_at_speed', 'cf_land_at_speed']);
  assert.match(crazyflieGenerator.workspaceToCode(ws), /cf_motion\("move", \[0, -\(n\), 0, 1 \/ 5\]\)/);
});

test('new motion sequence permits automatic connection but still requires explicit takeoff', () => {
  const ws = workspace([{ type: 'cf_hover' }]);
  assert.throws(() => compile(ws), /起飞/);
  assert.doesNotThrow(() => compile(workspace([chain({ type: 'cf_takeoff_at' }, { type: 'cf_land_at_speed' })])));
  const groundMove = workspace([chain(flight('cf_crazyflie_link'), { type: 'cf_move_xyz' })]);
  assert.throws(() => compile(groundMove), /起飞/);
  const duplicate = workspace([chain(flight('cf_crazyflie_link'), { type: 'cf_takeoff_at' }, { type: 'cf_takeoff_at' })]);
  assert.throws(() => compile(duplicate), /重复起飞/);
});

test('motion validation rejects bad arity, unknown operations, nonfinite values and nonpositive speeds', () => {
  for (const [kind, values] of [
    ['stop_motors', []], ['turn', [90]], ['move', [1, 0, 0, 0]],
    ['takeoff', [0, 0.2]], ['circle', [-1, 90, 0.2]], ['turn', [90, -1]],
    ['hover', [-1]], ['land', [NaN]], ['move', [Infinity, 0, 0, 1]],
  ]) {
    assert.throws(() => validateMotionCommand(kind, values));
  }
  assert.deepEqual(parseMotionCall('cf_motion("move", [1e-7, -0.2, 0, 0.3])'),
    { kind: 'move', values: [1e-7, -0.2, 0, 0.3] });
  assert.throws(() => parseMotionCall('cf_motion("turn", [90, 0])'));
  assert.throws(() => parseMotionCall('cf_motion("takeoff", [1e308, 1e-308])'));
});

test('motion and hover durations extend IPC timeout including the requested landing speed', () => {
  const code = [
    'cf_crazyflie_link()', 'cf_motion("takeoff", [1, 0.2])',
    'cf_motion("move", [0, 0, 0.5, 0.1])', 'cf_motion("hover", [60])',
    'cf_delay(2)', 'cf_motion("land", [0.1])',
  ].join('\n');
  assert.equal(motionFlowTimeoutMs(code), 147000);
  assert.equal(motionFlowTimeoutMs('cf_test_crazyflie_link()\ncf_delay(3)'), 83000);
  assert.equal(motionFlowTimeoutMs('cf_test_crazyflie_link()\ncf_test_crazyflie_link()'), 100000);
  assert.equal(motionDurationSeconds({ kind: 'circle', values: [0.5, 360, 0.5] }), 2 * Math.PI);
  assert.throws(() => motionFlowTimeoutMs('cf_motion("hover", [1e20])'), /计时器/);
});

test('turns change heading, legacy forward follows heading and arcs trace the correct body frame', async () => {
  const sim = simulator();
  sim.sleep = async () => {};
  const start = { ...sim.pose$.value };
  const result = await sim.runCode([
    'cf_crazyflie_link()',
    'cf_motion("takeoff", [0.5, 0.2])',
    'cf_motion("turn", [90, 45])',
    "cf_move('forward', 0.3)",
    'cf_motion("circle", [0.5, -90, 0.2])',
    'cf_motion("hover", [0])',
  ].join('\n'));
  assert.equal(result.success, true, result.message);
  const pose = sim.pose$.value;
  assert.ok(Math.abs(pose.x - (start.x - 0.5)) < 1e-9);
  assert.ok(Math.abs(pose.z - (start.z + 0.8)) < 1e-9);
  assert.ok(Math.abs(pose.y - (start.y + 0.5)) < 1e-9);
  assert.ok(Math.abs(pose.yaw) < 1e-9);
});

test('full circles return to the origin and XYZ motion supports simultaneous vertical translation', async () => {
  const sim = simulator();
  sim.sleep = async () => {};
  const start = { ...sim.pose$.value };
  const result = await sim.runCode([
    'cf_crazyflie_link()', 'cf_motion("takeoff", [0.5, 0.2])',
    'cf_motion("circle", [0.5, 360, 0.5])',
    'cf_motion("move", [0.2, 0.3, 0.1, 0.2])',
    'cf_motion("land", [0.1])',
  ].join('\n'));
  assert.equal(result.success, true, result.message);
  const pose = sim.pose$.value;
  assert.ok(Math.abs(pose.x - (start.x - 0.2)) < 1e-9);
  assert.ok(Math.abs(pose.z - (start.z + 0.3)) < 1e-9);
  assert.equal(pose.y, start.y);
  assert.ok(Math.abs(pose.yaw - 2 * Math.PI) < 1e-9);
});

test('legacy takeoff can precede new motion and uses the cflib default height above the takeoff surface', async () => {
  const sim = simulator();
  sim.sleep = async () => {};
  const ground = sim.pose$.value.y;
  const result = await sim.runCode('cf_crazyflie_link()\ncf_takeoff()\ncf_motion("hover", [0])');
  assert.equal(result.success, true, result.message);
  assert.ok(Math.abs(sim.pose$.value.y - ground - 0.3) < 1e-9);
});

test('motion simulation respects speed, hover duration and cancellation', async () => {
  const sim = simulator();
  const durations = [];
  sim.sleep = async ms => { durations.push(ms); };
  sim.speed$.next(2);
  const result = await sim.runCode([
    'cf_crazyflie_link()', 'cf_motion("takeoff", [0.4, 0.2])', 'cf_motion("hover", [1])',
  ].join('\n'));
  assert.equal(result.success, true);
  assert.ok(Math.abs(durations.reduce((a, b) => a + b, 0) - (75 + 1000 + 500)) < 1e-8);
  const cancelled = simulator();
  cancelled.sleep = async () => { cancelled.cancelRun(); };
  const before = { ...cancelled.pose$.value };
  const stopped = await cancelled.runCode('cf_crazyflie_link()\ncf_motion("takeoff", [0.4, 0.2])');
  assert.equal(stopped.success, false);
  assert.deepEqual({ ...cancelled.pose$.value }, before);
});

test('Python runner dispatches every motion API and cleans up without implicit takeoff', () => {
  const python = process.platform === 'win32' ? 'py' : 'python3';
  const args = process.platform === 'win32' ? ['-3'] : [];
  const result = spawnSync(python, [...args, '-B', '-c', `
import runpy
from pathlib import Path
ns = runpy.run_path(str(Path('child') / 'scripts' / 'crazyflie_run_flow.py'), run_name='motion_test')
calls = []
class Commander:
    def __init__(self, cf): calls.append(('created',))
    def __getattr__(self, name):
        return lambda *args, **kwargs: calls.append((name, args, kwargs))
wait = lambda seconds: calls.append(('wait', seconds))
session = ns['explicit_motion_session']
execute = ns['execute_motion']
with session(None, Commander) as mc:
    assert calls == [('created',)], calls
    for kind, values in [
        ('takeoff', [0.6, 0.2]), ('move', [0.1, -0.2, 0.3, 0.4]),
        ('turn', [90, 45]), ('turn', [-90, 30]),
        ('circle', [0.5, 180, 0.2]), ('circle', [0.3, -90, 0.1]),
        ('hover', [2]), ('move', [0, 0, 0, 0.2]), ('land', [0.1])
    ]:
        raw = 'cf_motion("' + kind + '", ' + str(values) + ')'
        command = ns['parse_commands'](raw)
        assert command == [('motion', {'kind': kind, 'values': values})], command
        execute(mc, command[0][1], wait)
assert calls[1] == ('take_off', (), {'height': 0.6, 'velocity': 0.2})
assert calls[2] == ('move_distance', (0.1, -0.2, 0.3), {'velocity': 0.4})
assert calls[3] == ('turn_left', (90,), {'rate': 45})
assert calls[4] == ('turn_right', (90,), {'rate': 30})
assert calls[5] == ('circle_left', (0.5,), {'velocity': 0.2, 'angle_degrees': 180})
assert calls[6] == ('circle_right', (0.3,), {'velocity': 0.1, 'angle_degrees': 90})
assert calls[7:10] == [('stop', (), {}), ('wait', 2), ('stop', (), {})]
assert calls[10] == ('land', (), {'velocity': 0.1})
assert calls[-1] == ('land', (), {})
try:
    with session(None, Commander) as mc:
        raise RuntimeError('test failure')
except RuntimeError:
    pass
assert calls[-1] == ('land', (), {})
for raw in ['cf_motion("move", [1,0,0,0])', 'cf_motion("hover", [-1])',
            'cf_motion("circle", [0,90,1])', 'cf_motion("turn", [90])',
            'cf_motion("takeoff", [True,1])', 'cf_motion("unknown", [])']:
    try:
        ns['parse_commands'](raw)
    except (ValueError, SyntaxError):
        pass
    else:
        raise AssertionError(raw)
valid = ns['parse_commands']('cf_crazyflie_link()\\ncf_motion("takeoff", [0.5,0.2])\\ncf_motion("hover", [1])\\ncf_motion("land", [0.2])')
ns['validate_motion_sequence'](valid)
ns['validate_motion_sequence'](valid[1:])
import sys, types
modules = {}
for name in ['cflib', 'cflib.crtp', 'cflib.crazyflie', 'cflib.crazyflie.syncCrazyflie',
             'cflib.crazyflie.log', 'cflib.crazyflie.syncLogger', 'cflib.positioning',
             'cflib.positioning.motion_commander', 'cflib.crtp.radiodriver',
             'cflib.utils', 'cflib.utils.multiranger']:
    module = types.ModuleType(name)
    modules[name] = module
    sys.modules[name] = module
    if '.' in name:
        parent, attr = name.rsplit('.', 1)
        setattr(modules[parent], attr, module)
class Connection:
    def __init__(self, uri):
        self.cf = types.SimpleNamespace(platform=types.SimpleNamespace(send_arming_request=lambda value: None))
    def __enter__(self): return self
    def __exit__(self, *args): pass
class LogConfig:
    def __init__(self, *args): raise RuntimeError('no telemetry in mock')
modules['cflib.crtp'].init_drivers = lambda **kwargs: None
modules['cflib.crazyflie.syncCrazyflie'].SyncCrazyflie = Connection
modules['cflib.crazyflie.log'].LogConfig = LogConfig
modules['cflib.crazyflie.syncLogger'].SyncLogger = object
modules['cflib.positioning.motion_commander'].MotionCommander = Commander
modules['cflib.crtp.radiodriver'].RadioDriver = lambda: types.SimpleNamespace(get_status=lambda: 'mock radio')
ns['run_flow'].__globals__['_radio_status'] = lambda uri: 'mock radio'
modules['cflib.utils.multiranger'].Multiranger = object
clock = [0]
def now():
    clock[0] += 1
    return clock[0]
ns['run_flow'].__globals__['time'] = types.SimpleNamespace(time=now, sleep=lambda value: None)
calls.clear()
result = ns['run_flow']('radio://mock', valid, 'E7E7E7E7E7')
assert result['success'], result
assert calls == [
    ('created',), ('take_off', (), {'height': 0.5, 'velocity': 0.2}),
    ('stop', (), {}), ('land', (), {'velocity': 0.2}), ('land', (), {})
], calls
assert len(result['executed']) == 4, result
legacy = ns['parse_commands']('cf_crazyflie_link()\\ncf_takeoff()\\ncf_motion("hover", [0])\\ncf_land()')
calls.clear()
result = ns['run_flow']('radio://mock', legacy, 'E7E7E7E7E7')
assert result['success'], result
assert calls[1] == ('take_off', (), {}), calls
print('motion API dispatch, sequence validation and cleanup passed')
`], { cwd: root, encoding: 'utf8' });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr);
});

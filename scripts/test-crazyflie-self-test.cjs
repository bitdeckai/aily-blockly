const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { test } = require('node:test');

const root = path.resolve(__dirname, '..');

test('real self-test waits for fresh firmware completion before advancing, with bounded failure and cleanup', () => {
  const python = process.platform === 'win32' ? 'py' : 'python3';
  const args = process.platform === 'win32' ? ['-3'] : [];
  const result = spawnSync(python, [...args, '-B', '-c', `
import io, runpy, sys, types, time
from contextlib import redirect_stdout
from pathlib import Path
from threading import Event, Thread
ns = runpy.run_path(str(Path('child') / 'scripts' / 'crazyflie_run_flow.py'), run_name='self_test')
modules = {}
for name in ['cflib', 'cflib.crtp', 'cflib.crazyflie', 'cflib.crazyflie.syncCrazyflie',
             'cflib.crazyflie.log', 'cflib.crazyflie.syncLogger', 'cflib.positioning',
             'cflib.positioning.motion_commander', 'cflib.utils', 'cflib.utils.multiranger']:
    module = types.ModuleType(name)
    modules[name] = sys.modules[name] = module
    if '.' in name:
        parent, attr = name.rsplit('.', 1)
        setattr(modules[parent], attr, module)

class Callback:
    def __init__(self): self.handlers = []
    def add_callback(self, handler): self.handlers.append(handler)
    def remove_callback(self, handler): self.handlers.remove(handler)
    def call(self, *args):
        for handler in list(self.handlers): handler(*args)

class Config:
    all = []
    def __init__(self, name, period_in_ms):
        self.name, self.period = name, period_in_ms
        self.variables = []
        self.data_received_cb, self.error_cb = Callback(), Callback()
        self.stopped, self.deleted = False, False
        self.all.append(self)
    def add_variable(self, name, kind): self.variables.append((name, kind))
    def start(self):
        if self.name != 'AilySelfTest': raise RuntimeError('No unrelated telemetry in fixture')
        fixture.config = self
        fixture.sample(100, fixture.count, fixture.mask)
    def stop(self): self.stopped = True
    def delete(self): self.deleted = True

class Fixture:
    def __init__(self, count=7, mask=143, missing=None):
        self.count, self.mask, self.config = count, mask, None
        self.writes = []
        self.triggered = Event()
        self.disconnected, self.connection_lost = Callback(), Callback()
        def find(name): return None if name == missing else object()
        toc = types.SimpleNamespace(get_element_by_complete_name=find)
        self.param = types.SimpleNamespace(toc=toc, set_value=self.set_value)
        self.log = types.SimpleNamespace(toc=toc, add_config=lambda config: None)
        self.cf = self
    def set_value(self, name, value):
        assert name == 'health.startPropTest' and value == '1'
        self.writes.append((name, value))
        self.triggered.set()
    def sample(self, timestamp, count, mask):
        if self.config:
            self.config.data_received_cb.call(timestamp, {
                'health.motorTestCount': count, 'health.motorPass': mask,
            }, self.config)

def forbidden(*args, **kwargs): raise AssertionError('Hardware access forbidden')
modules['cflib.crtp'].init_drivers = lambda **kwargs: None
modules['cflib.crazyflie.syncCrazyflie'].SyncCrazyflie = forbidden
modules['cflib.crazyflie.log'].LogConfig = Config
modules['cflib.crazyflie.syncLogger'].SyncLogger = forbidden
modules['cflib.positioning.motion_commander'].MotionCommander = forbidden
modules['cflib.utils.multiranger'].Multiranger = forbidden

commands = ns['parse_commands']('cf_test_crazyflie_link()\\ncf_delay(0)\\ncf_print("next")')
fixture = Fixture()
output, results, errors = io.StringIO(), [], []
def run():
    try:
        results.append(ns['run_flow']('radio://mock', commands, 'E7E7E7E7E7', connection=fixture))
    except Exception as error:
        errors.append(error)
with redirect_stdout(output):
    worker = Thread(target=run)
    worker.start()
    try:
        assert fixture.triggered.wait(1), errors
        worker.join(0.12)
        assert worker.is_alive(), 'self-test returned before firmware completion'
        assert '__STEP__:2/' not in output.getvalue(), output.getvalue()
        assert fixture.config.period == 100
        # A previous completed result and the trigger ACK are not completion.
        fixture.sample(101, 7, 143)
        fixture.sample(102, 7, 0)
        worker.join(0.04)
        assert worker.is_alive()
        assert '__STEP__:2/' not in output.getvalue()
        fixture.sample(103, 8, 143)
        worker.join(1)
        assert not worker.is_alive(), 'completion must not wait a fixed five seconds'
    finally:
        fixture.sample(104, 8, 143)
        worker.join(1)
assert not errors, errors
assert results[0]['executed'] == ['test_crazyflie_link', 'delay:0.0', 'print:next'], results
assert output.getvalue().index('self_test_completed') < output.getvalue().index('__STEP__:2/')
assert len(fixture.writes) == 1
assert fixture.config.stopped and fixture.config.deleted
assert not fixture.config.data_received_cb.handlers
assert not fixture.disconnected.handlers and not fixture.connection_lost.handlers

wait = ns['wait_for_propeller_test']
for count, mask in [(65535, 15), (10, 0), (12, 129)]:
    fixture = Fixture(count=count)
    failures = []
    def finish():
        try: wait(fixture, Config, lambda: None, timeout_sec=0.5)
        except Exception as error: failures.append(error)
    with redirect_stdout(io.StringIO()):
        worker = Thread(target=finish)
        worker.start()
        assert fixture.triggered.wait(1)
        # Reordered/duplicate packets must not finish the new test.
        fixture.sample(99, (count + 1) & 65535, mask)
        fixture.sample(100, (count + 1) & 65535, mask)
        worker.join(0.02)
        assert worker.is_alive()
        fixture.sample(101, (count + 1) & 65535, mask)
        worker.join(1)
    assert not worker.is_alive() and not failures, failures
    assert fixture.config.stopped and fixture.config.deleted

for fault in ['timeout', 'stale', 'log_error', 'disconnect', 'invalid', 'cancel', 'start_error', 'no_baseline', 'set_error']:
    fixture = Fixture()
    stopped = Event()
    failures = []
    def healthy():
        if stopped.is_set(): raise RuntimeError('Flight cancelled')
    def failing():
        try: wait(fixture, Config, healthy, timeout_sec=0.2, stale_sec=0.1)
        except Exception as error: failures.append(error)
    original = Config.start
    if fault == 'start_error':
        Config.start = lambda self: (_ for _ in ()).throw(RuntimeError('log start failed'))
    elif fault == 'no_baseline':
        Config.start = lambda self: setattr(fixture, 'config', self)
    if fault == 'set_error':
        fixture.param.set_value = lambda *args: (_ for _ in ()).throw(RuntimeError('parameter write failed'))
    try:
        with redirect_stdout(io.StringIO()):
            worker = Thread(target=failing)
            worker.start()
            if fault not in ['start_error', 'no_baseline', 'set_error']:
                assert fixture.triggered.wait(1)
                if fault == 'log_error': fixture.config.error_cb.call(fixture.config, 'log failed')
                elif fault == 'disconnect': fixture.disconnected.call('radio://mock')
                elif fault == 'invalid': fixture.sample(101, 'bad', 0)
                elif fault == 'cancel': stopped.set()
                elif fault == 'timeout':
                    for timestamp in range(101, 106):
                        fixture.sample(timestamp, fixture.count, 0)
                        time.sleep(0.04)
                elif fault == 'stale':
                    for _ in range(5):
                        fixture.sample(100, fixture.count, 0)
                        time.sleep(0.025)
            worker.join(1)
        assert not worker.is_alive() and failures, (fault, failures)
        expected = {'timeout':'SELF_TEST_TIMEOUT', 'stale':'SELF_TEST_NO_FEEDBACK',
                    'log_error':'log failed', 'disconnect':'disconnected',
                    'invalid':'Invalid self-test', 'cancel':'cancelled', 'start_error':'log start failed',
                    'no_baseline':'SELF_TEST_NO_FEEDBACK', 'set_error':'parameter write failed'}[fault]
        assert expected in str(failures[0]), (fault, failures)
        config = Config.all[-1]
        assert config.stopped and config.deleted, fault
        assert not config.data_received_cb.handlers and not config.error_cb.handlers, fault
        assert not fixture.disconnected.handlers and not fixture.connection_lost.handlers, fault
        if fault == 'no_baseline': assert not fixture.writes
    finally:
        Config.start = original

for missing in ['health.motorTestCount', 'health.motorPass', 'health.startPropTest']:
    fixture = Fixture(missing=missing)
    try: wait(fixture, Config, lambda: None)
    except RuntimeError as error: assert 'SELF_TEST_UNSUPPORTED' in str(error), error
    else: raise AssertionError('Unsupported firmware was allowed to trigger motors')
    assert not fixture.writes
fixture = Fixture()
stopped = Event()
stopped.set()
try: wait(fixture, Config, lambda: (_ for _ in ()).throw(RuntimeError('cancelled')))
except RuntimeError as error: assert 'cancelled' in str(error)
else: raise AssertionError('Cancelled self-test accepted')
assert not fixture.writes

# Failures in the shared helper must abort the actual flow, not only a direct call.
flow_globals = ns['run_flow'].__globals__
flow_globals['wait_for_propeller_test'] = lambda scf, config, healthy: wait(
    scf, config, healthy, timeout_sec=0.15, stale_sec=0.1)
for fault in ['cancel', 'log_error', 'unsupported', 'timeout']:
    fixture = Fixture(missing='health.motorTestCount' if fault == 'unsupported' else None)
    stopped = Event()
    errors = []
    output = io.StringIO()
    def failed_flow():
        try:
            ns['run_flow']('radio://mock', commands, 'E7E7E7E7E7',
                           connection=fixture, stop_requested=stopped)
        except Exception as error: errors.append(error)
    with redirect_stdout(output):
        worker = Thread(target=failed_flow)
        worker.start()
        if fault != 'unsupported':
            assert fixture.triggered.wait(1)
            if fault == 'cancel': stopped.set()
            elif fault == 'log_error': fixture.config.error_cb.call(fixture.config, 'test log failure')
        worker.join(1)
    assert not worker.is_alive() and errors, (fault, errors)
    assert '__STEP__:2/' not in output.getvalue(), (fault, output.getvalue())
    assert 'print:next' not in output.getvalue()
print('firmware completion sequencing, freshness, counter wrap, cancellation and cleanup verified offline')
`], { cwd: root, encoding: 'utf8', timeout: 15000 });
  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
});

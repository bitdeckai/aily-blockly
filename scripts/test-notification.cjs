const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');
const { Subject } = require('rxjs');
const ts = require('typescript');

const filename = path.join(__dirname, '..', 'src', 'app', 'components', 'notification',
  'notification.component.ts');
const { outputText } = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
  compilerOptions: {
    module: ts.ModuleKind.CommonJS,
    target: ts.ScriptTarget.ES2022,
    experimentalDecorators: true,
  },
  fileName: filename,
});

function fixture(t) {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const exports = {};
  const dependencies = {
    '@angular/core': { Component: () => target => target },
    '@angular/common': { CommonModule: {} },
    'ng-zorro-antd/progress': { NzProgressModule: {} },
    '@ngx-translate/core': { TranslateModule: {} },
  };
  vm.runInNewContext(outputText, {
    exports,
    require(name) {
      assert.ok(Object.hasOwn(dependencies, name), `Unexpected dependency: ${name}`);
      return dependencies[name];
    },
    setTimeout: (...args) => setTimeout(...args),
    clearTimeout: handle => clearTimeout(handle),
    requestAnimationFrame: () => 1,
    cancelAnimationFrame: () => {},
    performance,
  }, { filename });
  const stateSubject = new Subject();
  const cd = { detectChanges: t.mock.fn() };
  const component = new exports.NotificationComponent({ stateSubject }, cd, {}, {}, {});
  component.getTextWidth = () => 0;
  component.ngOnInit();
  t.after(() => component.ngOnDestroy());
  return { component, stateSubject, cd };
}

test('successful notifications start dismissing at five seconds and retain the closing animation', t => {
  const { component, stateSubject } = fixture(t);
  stateSubject.next({ state: 'done', title: 'Crazyflie', text: 'Link OK' });
  t.mock.timers.tick(4999);
  assert.equal(component.willClose, false);
  assert.equal(component.data.text, 'Link OK');
  t.mock.timers.tick(1);
  assert.equal(component.willClose, true);
  t.mock.timers.tick(499);
  assert.ok(component.data);
  t.mock.timers.tick(1);
  assert.equal(component.data, null);
});

test('success uses five seconds even when callers supply zero or a longer delay', t => {
  const { component, stateSubject } = fixture(t);
  for (const setTimeout of [0, 15000, 60000]) {
    stateSubject.next({ state: 'done', text: 'OK', setTimeout });
    t.mock.timers.tick(5000);
    assert.equal(component.willClose, true, `Caller delay: ${setTimeout}`);
    t.mock.timers.tick(500);
    assert.equal(component.data, null);
  }
});

test('errors remain until manually closed even when callers supply an expiry', t => {
  const { component, stateSubject } = fixture(t);
  for (const setTimeout of [undefined, 1000, 180000]) {
    stateSubject.next({ state: 'error', text: 'Connection failed', setTimeout });
    t.mock.timers.tick(300000);
    assert.equal(component.data.text, 'Connection failed');
    assert.equal(component.willClose, false);
    component.close();
    t.mock.timers.tick(500);
    assert.equal(component.data, null);
  }
});

test('an error arriving during success fade-out cancels the old close callback', t => {
  const { component, stateSubject } = fixture(t);
  stateSubject.next({ state: 'done', text: 'Link OK' });
  t.mock.timers.tick(5000);
  assert.equal(component.willClose, true);
  t.mock.timers.tick(250);
  stateSubject.next({ state: 'error', text: 'Connection lost', setTimeout: 1000 });
  assert.equal(component.willClose, false);
  t.mock.timers.tick(300000);
  assert.equal(component.data.text, 'Connection lost');
  assert.equal(component.willClose, false);
});

test('a replacement success gets a full five seconds instead of the previous deadline', t => {
  const { component, stateSubject } = fixture(t);
  stateSubject.next({ state: 'done', text: 'First task' });
  t.mock.timers.tick(4000);
  stateSubject.next({ state: 'done', text: 'Second task' });
  t.mock.timers.tick(4999);
  assert.equal(component.willClose, false);
  assert.equal(component.data.text, 'Second task');
  t.mock.timers.tick(1);
  assert.equal(component.willClose, true);
  t.mock.timers.tick(500);
  assert.equal(component.data, null);
});

test('a new in-progress notice survives a previous manual close and keeps cancellation', t => {
  const { component, stateSubject } = fixture(t);
  stateSubject.next({ state: 'error', text: 'Previous error' });
  component.close();
  t.mock.timers.tick(250);
  const stop = t.mock.fn();
  stateSubject.next({ state: 'doing', text: 'Running', stop, setTimeout: 0 });
  t.mock.timers.tick(300000);
  assert.equal(component.data.text, 'Running');
  assert.equal(component.willClose, false);
  assert.equal(component.isClosable, false);
  component.stop();
  assert.equal(stop.mock.callCount(), 1);
});

test('warning expiry continues to respect its caller-provided duration', t => {
  const { component, stateSubject } = fixture(t);
  stateSubject.next({ state: 'warn', text: 'Cancelled', setTimeout: 2000 });
  t.mock.timers.tick(1999);
  assert.equal(component.willClose, false);
  t.mock.timers.tick(1);
  assert.equal(component.willClose, true);
  t.mock.timers.tick(500);
  assert.equal(component.data, null);
});

test('clearing a notice cancels pending dismissal before another error arrives', t => {
  const { component, stateSubject } = fixture(t);
  stateSubject.next({ state: 'done', text: 'Done' });
  t.mock.timers.tick(5000);
  stateSubject.next(null);
  assert.equal(component.data, null);
  assert.equal(component.willClose, false);
  stateSubject.next({ state: 'error', text: 'New error' });
  t.mock.timers.tick(300000);
  assert.equal(component.data.text, 'New error');
});

test('destroying the component unsubscribes and cancels pending fade-out callbacks', t => {
  const { component, stateSubject, cd } = fixture(t);
  stateSubject.next({ state: 'done', text: 'Done' });
  t.mock.timers.tick(5000);
  const previousCalls = cd.detectChanges.mock.callCount();
  component.ngOnDestroy();
  assert.equal(stateSubject.observers.length, 0);
  stateSubject.next({ state: 'error', text: 'Not rendered' });
  t.mock.timers.tick(300000);
  assert.equal(cd.detectChanges.mock.callCount(), previousCalls);
  assert.equal(component.data.text, 'Done');
});

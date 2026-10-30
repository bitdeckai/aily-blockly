const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const { test } = require('node:test');

function bluetooth() {
  const handlers = new Map();
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', 'electron', 'ble.js'), 'utf8'), {
    module, console: { log() {} },
    require: name => {
      assert.equal(name, 'electron');
      return { ipcMain: { handle: (name, handler) => handlers.set(name, handler) } };
    },
  });
  module.exports.registerBleHandlers();

  function window() {
    const target = new EventEmitter();
    const contents = new EventEmitter();
    const sent = [];
    let destroyed = false;
    contents.session = {
      setPermissionCheckHandler() {},
      setPermissionRequestHandler() {},
      setDevicePermissionHandler() {},
      setBluetoothPairingHandler() {},
    };
    contents.isDestroyed = () => destroyed;
    contents.send = (channel, devices) => sent.push({ channel, devices });
    Object.defineProperty(target, 'webContents', {
      get() {
        if (destroyed) throw new TypeError('Object has been destroyed');
        return contents;
      },
    });
    module.exports.registerWebBluetoothChooser(target);
    return {
      contents, sent,
      close() { destroyed = true; target.emit('closed'); },
      request(devices, callback) {
        let prevented = false;
        contents.emit('select-bluetooth-device', { preventDefault() { prevented = true; } }, devices, callback);
        assert.ok(prevented);
      },
      invoke: (channel, ...args) => handlers.get(channel)({ sender: contents }, ...args),
    };
  }
  return { window };
}

test('closing a window without a BLE request never reads its destroyed BrowserWindow', () => {
  const target = bluetooth().window();
  assert.doesNotThrow(() => target.close());
});

test('closing the request owner clears stale selection without calling a destroyed chooser', async () => {
  const target = bluetooth().window();
  const selections = [];
  target.request([{ deviceId: 'radio', deviceName: 'Crazyflie' }], id => selections.push(id));
  assert.equal((await target.invoke('ble-debug-state')).hasPendingSelection, true);
  assert.doesNotThrow(() => target.close());
  assert.equal((await target.invoke('ble-debug-state')).hasPendingSelection, false);
  assert.equal((await target.invoke('ble-select-device', 'radio')).success, false);
  assert.deepEqual(selections, []);
});

test('closing another window preserves the live request and its selection callback', async () => {
  const harness = bluetooth();
  const other = harness.window();
  const owner = harness.window();
  const selections = [];
  owner.request([], id => selections.push(id));
  assert.doesNotThrow(() => other.close());
  assert.equal((await owner.invoke('ble-select-device', 'radio')).success, true);
  assert.deepEqual(selections, ['radio']);
  assert.equal((await owner.invoke('ble-debug-state')).hasPendingSelection, false);
  assert.doesNotThrow(() => owner.close());
});

test('device updates remain normalized and deduplicated until the user selects a device', async () => {
  const target = bluetooth().window();
  const selections = [];
  const devices = [
    { id: 'radio', name: 'Old name' }, null,
    { deviceId: 'radio', deviceName: 'Crazyflie' }, { name: 'Missing ID' },
  ];
  target.request(devices, id => selections.push(id));
  target.request(devices, id => selections.push(id));
  assert.equal(target.sent.length, 1);
  assert.equal(target.sent[0].channel, 'ble-device-list');
  assert.deepEqual(JSON.parse(JSON.stringify(target.sent[0].devices)),
    [{ deviceId: 'radio', deviceName: 'Crazyflie' }]);
  assert.equal((await target.invoke('ble-select-device', 'radio')).success, true);
  assert.deepEqual(selections, ['radio']);
  assert.doesNotThrow(() => target.close());
});

test('preferred selection still resumes paused discovery and clears the pending callback', async () => {
  const target = bluetooth().window();
  const selections = [];
  await target.invoke('ble-stop-device-list-updates');
  target.request([], id => selections.push(id));
  assert.equal(target.sent.length, 0);
  await target.invoke('ble-set-preferred-device', 'radio');
  target.request([{ deviceId: 'radio' }], id => selections.push(id));
  assert.deepEqual(selections, ['radio']);
  assert.equal((await target.invoke('ble-debug-state')).hasPendingSelection, false);
  assert.doesNotThrow(() => target.close());
});

test('cancellation before and during discovery still completes each request once', async () => {
  const target = bluetooth().window();
  const selections = [];
  await target.invoke('ble-cancel-device-request');
  target.request([], id => selections.push(id));
  assert.deepEqual(selections, ['']);
  assert.equal((await target.invoke('ble-debug-state')).hasPendingSelection, false);
  target.request([], id => selections.push(id));
  await target.invoke('ble-cancel-device-request');
  assert.deepEqual(selections, ['', '']);
  assert.equal((await target.invoke('ble-debug-state')).hasPendingSelection, false);
  assert.doesNotThrow(() => target.close());
});

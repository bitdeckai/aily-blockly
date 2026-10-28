const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const { test } = require('node:test');
const ts = require('typescript');

const filename = path.join(__dirname, '..', 'electron', 'main.js');
const source = ts.createSourceFile(filename, fs.readFileSync(filename, 'utf8'), ts.ScriptTarget.Latest, true);
const startup = source.statements.find(node => ts.isFunctionDeclaration(node) && node.name.text === 'createWindow');
const statements = startup.body.statements;
const end = statements.findIndex(node => ts.isVariableStatement(node)
  && node.declarationList.declarations.some(declaration => declaration.name.getText(source) === 'targetUrl'));
assert.ok(end > 0, 'window startup must precede navigation');
const code = statements.slice(0, end).map(node => node.getText(source)).join('\n');
const geometryCode = ['rectsOverlap', 'ensureWinStateOnVisibleDisplay'].map(name =>
  source.statements.find(node => ts.isFunctionDeclaration(node) && node.name.text === name).getText(source)).join('\n');

function openWindow({ isWin32 = true, firstLaunch = false,
  displays = [{ workArea: { x: 0, y: 0, width: 1920, height: 1040 } }], ...saved } = {}) {
  const state = { width: 1200, height: 780, x: 100, y: 56, ...saved };
  const persisted = [];
  let window;
  const context = {
    path, process: { env: { AILY_APPDATA_PATH: 'appdata' }, resourcesPath: 'resources' },
    fs: { existsSync: () => !firstLaunch },
    __dirname: path.dirname(filename), serve: true, isWin32, isDarwin: !isWin32,
    console, registerWebBluetoothChooser() {},
    screen: {
      getAllDisplays: () => displays,
      getPrimaryDisplay: () => displays[0],
      getDisplayMatching: rect => displays.find(({ workArea: area }) => rect.x < area.x + area.width
        && rect.x + rect.width > area.x && rect.y < area.y + area.height && rect.y + rect.height > area.y),
    },
    WinState: class {
      state = state;
      winOptions = { width: state.width, height: state.height, x: state.x, y: state.y };
      saveState() { persisted.push({ ...state }); }
      manage() {}
    },
    BrowserWindow: class extends EventEmitter {
      constructor(options) {
        super();
        window = this;
        this.options = options;
        this.maximized = false;
        this.fullScreen = false;
        this.visible = false;
      }
      setBounds(bounds) { this.bounds = { ...bounds }; }
      maximize() { this.maximized = true; }
      setFullScreen(value) { this.fullScreen = value; }
      show() { this.visible = true; }
      isDestroyed() { return false; }
      isMaximized() { return this.maximized; }
      isFullScreen() { return this.fullScreen; }
    },
  };
  vm.runInNewContext(`${geometryCode}\n${code}`, context);
  window.emit('ready-to-show');
  return { window, state, persisted };
}

test('Windows clears a saved fullscreen state and restores a normal window', () => {
  const { window, state, persisted } = openWindow({ isFullScreen: true, isMaximized: false });
  assert.equal(window.fullScreen, false);
  assert.equal(window.maximized, false);
  assert.equal(window.visible, true);
  assert.deepEqual(window.bounds, { width: 1200, height: 780, x: 100, y: 56,
    isFullScreen: false, isMaximized: false });
  assert.equal(state.isFullScreen, false);
  assert.equal(persisted.length, 1);
  assert.equal(persisted[0].isFullScreen, false, 'the old fullscreen preference is cleared on disk');
});

test('Windows preserves maximization and maximizes first launch without fullscreen', () => {
  for (const options of [{ isMaximized: true, isFullScreen: true }, { firstLaunch: true }]) {
    const { window } = openWindow(options);
    assert.equal(window.maximized, true);
    assert.equal(window.fullScreen, false);
    assert.equal(window.visible, true);
  }
});

test('Windows fits partially visible and oversized saved windows inside the taskbar work area', () => {
  const displays = [{ workArea: { x: 0, y: 0, width: 1536, height: 816 } }];
  const { window } = openWindow({ displays, width: 1204, height: 804, x: 100, y: 56 });
  assert.equal(window.bounds.y, 12, 'the saved bottom edge must no longer extend behind the taskbar');
  assert.equal(window.bounds.height, 804, 'moving the window is enough when its size still fits');
  const oversized = openWindow({ displays, width: 1920, height: 1080, x: -40, y: -30 }).window;
  assert.equal(oversized.bounds.x, 0);
  assert.equal(oversized.bounds.y, 0);
  assert.equal(oversized.bounds.width, 1536);
  assert.equal(oversized.bounds.height, 816);
});

test('Windows preserves a connected secondary monitor and recenters a removed-monitor window', () => {
  const displays = [
    { workArea: { x: 0, y: 0, width: 1536, height: 816 } },
    { workArea: { x: -1920, y: 0, width: 1920, height: 1040 } },
  ];
  const secondary = openWindow({ displays, x: -1800, y: 40 }).window;
  assert.equal(secondary.bounds.x, -1800);
  assert.equal(secondary.bounds.y, 40);
  const removed = openWindow({ displays: [displays[0]], x: -1800, y: 40 }).window;
  assert.equal(removed.bounds.x, 168);
  assert.equal(removed.bounds.y, 18);
});

test('Windows does not persist fullscreen when closing, but still persists maximization', () => {
  const { window, state, persisted } = openWindow();
  window.fullScreen = true;
  window.maximized = true;
  window.emit('close');
  assert.equal(state.isFullScreen, false);
  assert.equal(state.isMaximized, true);
  assert.equal(persisted.at(-1).isFullScreen, false);
});

test('non-Windows startup and close retain the existing fullscreen behavior', () => {
  const { window, state, persisted } = openWindow({ isWin32: false, isFullScreen: true, x: -40, y: -30 });
  assert.equal(window.fullScreen, true);
  assert.equal(window.bounds.x, -40);
  assert.equal(window.bounds.y, -30);
  assert.equal(persisted.length, 0);
  window.emit('close');
  assert.equal(state.isFullScreen, true);
  assert.equal(persisted.at(-1).isFullScreen, true);
});

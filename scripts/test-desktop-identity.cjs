const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');
const ts = require('typescript');
const { AppInfo } = require('app-builder-lib/out/appInfo');

const root = path.resolve(__dirname, '..');
const read = filename => fs.readFileSync(path.join(root, filename), 'utf8');
const metadata = JSON.parse(read('package.json'));
const mainSource = read('electron/main.js');
const main = ts.createSourceFile('main.js', mainSource, ts.ScriptTarget.Latest, true);
const quiet = { log() {}, warn() {}, error() {} };

function identity(platform = 'win32') {
  const module = { exports: {} };
  vm.runInNewContext(read('electron/desktop-identity.js'), {
    module, exports: module.exports, require,
    __dirname: path.join(root, 'electron'),
    process: { platform, resourcesPath: path.join(root, 'installed-resources') },
  });
  return module.exports;
}

function mockApp() {
  const events = [];
  const paths = { appData: path.join(root, 'test-app-data'), userData: 'legacy-profile' };
  return {
    events, paths, isPackaged: false,
    setName: value => events.push(['name', value]),
    getPath: key => paths[key],
    setPath: (key, value) => { paths[key] = value; events.push(['path', key, value]); },
    setAppUserModelId: value => events.push(['appId', value]),
    commandLine: { appendSwitch() {} },
  };
}

function mainFunction(name) {
  return main.statements.find(node => ts.isFunctionDeclaration(node) && node.name.text === name).getText(main);
}

test('Windows identity is set synchronously before app services, profiles, locks or windows', () => {
  const desktop = identity();
  const app = mockApp();
  const end = main.statements.findIndex(node => ts.isVariableStatement(node)
    && node.declarationList.declarations.some(declaration => declaration.name.getText(main) === 'PROTOCOL'));
  assert.ok(end > 0);
  const earlyStartup = main.statements.slice(0, end).map(node => node.getText(main)).join('\n');
  const expected = [
    ['name', 'RobotSTEM'],
    ['path', 'userData', path.join(app.paths.appData, 'RobotSTEM')],
    ['appId', 'org.robotstem.desktop'],
  ];
  vm.runInNewContext(earlyStartup, {
    require: name => {
      if (['path', 'os', 'fs'].includes(name)) return require(name);
      if (name === 'electron') return { app };
      if (name === './desktop-identity') return desktop;
      assert.deepEqual(app.events, expected, `identity must precede ${name}`);
      if (name === 'electron-win-state') return { default: class {} };
      if (name === './platform') return { isWin32: true };
      if (name === './project-lock') return {};
      throw new Error(`Unexpected startup import: ${name}`);
    },
  });
  assert.deepEqual(app.events, expected);
  assert.doesNotMatch(mainSource, /app\.setName|app\.setAppUserModelId|legacyUserDataPath/);
});

test('development and packaged runs use the same name, ID and isolated Windows profile', () => {
  for (const isPackaged of [false, true]) {
    const app = mockApp();
    app.isPackaged = isPackaged;
    identity().configureDesktopIdentity(app);
    assert.equal(app.paths.userData, path.join(app.paths.appData, 'RobotSTEM'));
    assert.deepEqual(app.events.filter(([event]) => event !== 'path'), [
      ['name', metadata.productName], ['appId', metadata.build.appId],
    ]);
  }
});

test('non-Windows retains its legacy profile and does not call Windows identity APIs', () => {
  for (const platform of ['darwin', 'linux']) {
    const app = mockApp();
    app.setAppUserModelId = () => { throw new Error('Windows-only API'); };
    identity(platform).configureDesktopIdentity(app);
    assert.equal(app.paths.userData, path.join(app.paths.appData, 'aily blockly'));
    assert.deepEqual(app.events[0], ['name', 'RobotSTEM']);
    identity(platform).configureWindowIdentity({
      setAppDetails() { throw new Error('Windows-only window API'); },
    });
  }
});

test('Windows profiles and locks are isolated while legacy OAuth state still routes callbacks', () => {
  const desktop = identity();
  const files = new Map([['legacy-profile-marker', 'keep']]);
  const legacyProfile = path.join(root, 'test-app-data', 'aily blockly', 'instances', 'instance-0');
  const oauthStatePath = path.join(root, 'test-app-data', 'aily blockly', 'oauth-instances.json');
  const directories = new Set([legacyProfile]);
  files.set(oauthStatePath, JSON.stringify({
    'legacy-login': { instanceId: 8000, userDataPath: legacyProfile, timestamp: Date.now() },
  }));
  const fileSystem = {
    existsSync: filename => files.has(filename) || directories.has(filename),
    mkdirSync: filename => directories.add(filename),
    readdirSync: dirname => [...directories].filter(filename => path.dirname(filename) === dirname).map(filename => path.basename(filename)),
    readFileSync: filename => files.get(filename),
    writeFileSync: (filename, value) => files.set(filename, value),
    rmSync() { throw new Error('No existing cache should be touched in this test'); },
  };
  const profiles = [];
  for (const pid of [9001, 9002]) {
    const app = mockApp();
    desktop.configureDesktopIdentity(app);
    const baseProfile = app.paths.userData;
    const context = {
      app, path, fs: fileSystem, console: quiet, isWin32: true,
      process: { pid, kill() {} },
    };
    const functions = ['isProcessRunning', 'clearSlowCaches', 'setupPooledUserDataPath',
      'shouldUseMultiInstance', 'getOAuthStateFilePath', 'registerOAuthInstance',
      'findOAuthInstance'].map(mainFunction).join('\n');
    vm.runInNewContext(`let heldInstanceLockPath = null;
      const OAUTH_STATE_FILE = 'oauth-instances.json';
      ${functions}
      initialOAuthPath = getOAuthStateFilePath();
      profile = setupPooledUserDataPath();
      pooledOAuthPath = getOAuthStateFilePath();
      registered = registerOAuthInstance('login-' + process.pid);
      legacyInstance = findOAuthInstance('legacy-login');`, context);
    assert.equal(context.initialOAuthPath, oauthStatePath);
    assert.equal(context.pooledOAuthPath, oauthStatePath, 'protocol and pooled launches retain shared callback routing');
    assert.equal(context.profile, path.join(baseProfile, 'instances', `instance-${profiles.length}`));
    assert.equal(context.registered.userDataPath, context.profile);
    assert.equal(context.legacyInstance.userDataPath, legacyProfile, 'a callback can still reach an already running Aily instance');
    profiles.push(context.profile);
  }
  assert.notEqual(profiles[0], profiles[1]);
  assert.equal(files.get('legacy-profile-marker'), 'keep');
  assert.ok([...files.keys()].filter(filename => filename !== 'legacy-profile-marker' && filename !== oauthStatePath)
    .every(filename => filename.startsWith(path.join(root, 'test-app-data', 'RobotSTEM', 'instances'))));
  const states = JSON.parse(files.get(oauthStatePath));
  assert.equal(states['login-9001'].userDataPath, profiles[0]);
  assert.equal(states['login-9002'].userDataPath, profiles[1]);
  assert.equal(states['legacy-login'].userDataPath, legacyProfile);

  const lock = main.statements.find(node => ts.isVariableStatement(node)
    && node.declarationList.declarations.some(declaration => declaration.name.getText(main) === 'gotTheLock'));
  let observedProfile;
  const app = mockApp();
  desktop.configureDesktopIdentity(app);
  vm.runInNewContext(lock.getText(main), {
    app: { requestSingleInstanceLock() { observedProfile = app.paths.userData; return true; } },
  });
  assert.equal(observedProfile, path.join(app.paths.appData, 'RobotSTEM'));
});

test('main, fallback and pooled windows explicitly set taskbar identity and icons before use', () => {
  const constructors = [];
  for (const filename of ['electron/main.js', 'electron/window.js']) {
    const source = ts.createSourceFile(filename, read(filename), ts.ScriptTarget.Latest, true);
    function visit(node) {
      if (ts.isNewExpression(node) && node.expression.getText(source) === 'BrowserWindow') {
        let statement = node;
        while (statement.parent && !ts.isBlock(statement.parent)) statement = statement.parent;
        const statements = statement.parent.statements;
        const nextStatement = statements[statements.indexOf(statement) + 1];
        assert.match(nextStatement.getText(source), /^configureWindowIdentity\(/, 'identity must immediately follow window creation');
        constructors.push(`${statement.getText(source)}\n${nextStatement.getText(source)}`);
      }
      ts.forEachChild(node, visit);
    }
    visit(source);
  }
  assert.equal(constructors.length, 3);
  for (const isPackaged of [false, true]) {
    for (const code of constructors) {
      let options;
      let details;
      const desktop = identity();
      vm.runInNewContext(code, {
        app: { isPackaged }, getWindowIcon: desktop.getWindowIcon,
        configureWindowIdentity: desktop.configureWindowIdentity,
        BrowserWindow: class {
          constructor(value) { options = value; }
          setAppDetails(value) { details = value; }
        },
        winState: { winOptions: {}, state: {} },
        screen: { getDisplayMatching: () => ({ workArea: { width: 1920, height: 1080 } }) },
        isWin32: true, isDarwin: false, serve: false, path,
        process: { platform: 'win32' }, __dirname: path.join(root, 'electron'),
        width: 800, height: 600, alwaysOnTop: false, getSubWindowWebPreferences: () => ({}),
      });
      assert.equal(options.icon, isPackaged
        ? path.join(root, 'installed-resources', 'icon.ico')
        : path.join(root, 'public', 'robotstem.ico'));
      assert.equal(details.appId, 'org.robotstem.desktop');
    }
  }
});

test('builder executable, NSIS shortcut and process identities agree without renaming compatibility IDs', () => {
  const desktop = identity();
  const appInfo = new AppInfo({ metadata, config: metadata.build }, null, metadata.build.win);
  assert.equal(desktop.APP_ID, 'org.robotstem.desktop');
  assert.equal(appInfo.id, desktop.APP_ID);
  assert.equal(appInfo.productName, desktop.APP_NAME);
  assert.equal(appInfo.productFilename, 'RobotSTEM');
  assert.equal(metadata.build.nsis.shortcutName, desktop.APP_NAME);
  assert.equal(metadata.build.nsis.createStartMenuShortcut, true);
  assert.equal(metadata.build.nsis.deleteAppDataOnUninstall, false);
  assert.equal(metadata.build.win.icon, 'public/robotstem.ico');
  assert.equal(metadata.build.linux.icon, 'public/robotstem.png');
  assert.ok(metadata.build.extraResources.some(resource => resource.from === 'public/robotstem.ico' && resource.to === 'icon.ico'));
  const installer = read('build/installer.nsh');
  assert.equal((installer.match(/^\s*CreateShortcut /gmi) || []).length, 1, 'do not overwrite the shortcut after setting its AUMI');
  assert.match(installer, /CreateShortcut "\$DESKTOP\\\$\{PRODUCT_NAME\}\.lnk"[^\r\n]*resources\\icon\.ico[^\r\n]*[\r\n]+[^\r\n]*[\r\n]+\s*WinShell::SetLnkAUMI "\$DESKTOP\\\$\{PRODUCT_NAME\}\.lnk" "\$\{APP_ID\}"/);
  assert.doesNotMatch(installer, /taskkill|!macro customInit/i, 'builder must handle only its own executable, not force-close Aily');
  const builderShortcutTemplate = fs.readFileSync(path.join(root, 'node_modules', 'app-builder-lib', 'templates', 'nsis', 'include', 'installer.nsh'), 'utf8');
  assert.match(builderShortcutTemplate, /WinShell::SetLnkAUMI "\$newStartMenuLink" "\$\{APP_ID\}"/);
  assert.equal(metadata.name, 'aily-blockly');
  assert.equal(metadata.build.publish, null);
  assert.deepEqual(metadata.build.protocols[0].schemes, ['ailyblockly']);
  assert.match(mainSource, /const PROTOCOL = "abis";/);
  assert.equal(metadata.build.win.fileAssociations[0].ext, 'abi');
});

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');
const ts = require('typescript');
const rxjs = require('rxjs');

const root = path.resolve(__dirname, '..');
const deviceName = '@aily-project/board-crazyflie';
const devicePath = path.join(root, 'child', 'boards', 'board-crazyflie');
const templatePath = path.join(devicePath, 'template');
const quiet = { log() {}, warn() {}, error() {} };
const read = relative => fs.readFileSync(path.join(root, relative), 'utf8');

function desktop({ missing = [], overrides = new Map() } = {}) {
  const writes = new Map();
  return {
    path: {
      join: path.join,
      getAilyChildPath: () => path.join(root, 'child'),
      getAppDataPath: () => 'appdata',
      isExists: filename => !missing.includes(filename) && fs.existsSync(filename),
    },
    fs: {
      existsSync: filename => !missing.includes(filename) && fs.existsSync(filename),
      readFileSync: filename => writes.get(filename) ?? overrides.get(filename) ?? fs.readFileSync(filename, 'utf8'),
      writeFileSync: (filename, content) => writes.set(filename, content),
    },
    writes,
  };
}

function loadService(relative, window = desktop()) {
  const modules = new Map();
  function load(filename) {
    if (modules.has(filename)) return modules.get(filename);
    const exports = {};
    modules.set(filename, exports);
    const code = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, experimentalDecorators: true },
    }).outputText;
    vm.runInNewContext(code, {
      exports, window, console: quiet, Error,
      setTimeout: () => { throw new Error('Unexpected background timer'); },
      require: name => {
        if (name === '@angular/core') return {
          Injectable: () => target => target,
          Component: () => target => target,
        };
        if (name === '@angular/common/http') return { HttpErrorResponse: class extends Error {} };
        if (name === 'rxjs') return rxjs;
        if (name === 'rxjs/operators' || name.startsWith('@orama/')) return require(name);
        if (name.endsWith('fuzzy-search.utils')) return load(path.join(root, 'src', 'app', 'utils', 'fuzzy-search.utils.ts'));
        if (name.endsWith('robot-device-catalog')) return load(path.join(root, 'src', 'app', 'services', 'robot-device-catalog.ts'));
        if (name.endsWith('package.json')) return require(path.join(root, 'package.json'));
        return {};
      },
    }, { filename });
    return exports;
  }
  return load(path.join(root, relative));
}

function project(window) {
  const { ProjectService } = loadService('src/app/services/project.service.ts', window);
  const service = Object.create(ProjectService.prototype);
  const effects = [];
  const errors = [];
  service.translate = { instant: key => key };
  service.message = {
    error: message => errors.push(message),
    loading: message => effects.push(['loading', message]),
    success: message => effects.push(['success', message]),
  };
  service.uiService = { updateFooterState: state => effects.push(['footer', state.state]) };
  service.platformService = { getPlatformSeparator: () => path.sep };
  service.crossPlatformCmdService = {
    createDirectory: async filename => effects.push(['mkdir', filename]),
    copyItem: async (source, target) => {
      effects.push(['copy', source, target]);
      window.writes.set(`${target}/package.json`, read('child/boards/board-crazyflie/template/package.json'));
    },
  };
  service.cmdService = { runAsync: async () => { throw new Error('Unexpected remote installation'); } };
  window.iWindow = { send: async data => effects.push(['open', data]) };
  return { service, effects, errors };
}

test('one offline catalog loads the bundled Crazyflie package and template', () => {
  const catalog = loadService('src/app/services/robot-device-catalog.ts');
  const devices = catalog.loadRobotDeviceCatalog();
  assert.equal(devices.length, 1);
  assert.equal(devices[0].name, deviceName);
  assert.equal(devices[0].sourcePath, devicePath);
  assert.ok(fs.existsSync(devices[0].imgLocalPath));
  assert.ok(catalog.isSupportedRobotDevice(deviceName));
  for (const name of [undefined, null, '', 'board-crazyflie', '@aily-project/board-arduino_uno', `${deviceName}-other`]) {
    assert.equal(catalog.isSupportedRobotDevice(name), false);
  }
});

test('missing desktop resources or invalid manifests fail explicitly without a fallback board', () => {
  const packageFile = path.join(devicePath, 'package.json');
  const templateFile = path.join(templatePath, 'package.json');
  const cases = [
    {},
    desktop({ missing: [packageFile] }),
    desktop({ missing: [templateFile] }),
    desktop({ overrides: new Map([[packageFile, '{}']]) }),
    desktop({ overrides: new Map([[packageFile, '{']]) }),
    desktop({ overrides: new Map([[templateFile, '{}']]) }),
    desktop({ overrides: new Map([[templateFile, '{']]) }),
  ];
  for (const window of cases) {
    assert.throws(() => loadService('src/app/services/robot-device-catalog.ts', window).loadRobotDeviceCatalog());
  }
});

test('project templates must actually depend on Crazyflie and no other board', () => {
  const { isSupportedRobotProject } = loadService('src/app/services/robot-device-catalog.ts');
  assert.equal(isSupportedRobotProject({ dependencies: { [deviceName]: '0.0.1', motion: '1' } }), true);
  for (const manifest of [null, {}, { dependencies: {} }, { dependencies: { other: '1' } },
    { dependencies: { [deviceName]: '1', '@aily-project/board-arduino_uno': '1' } }]) {
    assert.equal(isSupportedRobotProject(manifest), false);
  }
});

test('both project entry points have valid Angular empty-state control flow', async () => {
  const { parseTemplate } = await import('@angular/compiler');
  for (const filename of [
    'src/app/pages/project-new/project-new.component.html',
    'src/app/windows/project-new/project-new.component.html',
  ]) {
    const result = parseTemplate(read(filename), filename);
    assert.equal(result.errors, null, result.errors?.map(error => error.toString()).join('\n'));
  }
});

test('both project entry points still select bundled Crazyflie without remote version lookups', async () => {
  for (const entry of ['pages', 'windows']) {
    const window = desktop();
    window.path.getUserDocuments = () => 'documents';
    const catalog = loadService('src/app/services/robot-device-catalog.ts', window).loadRobotDeviceCatalog();
    const original = JSON.stringify(catalog);
    const { ProjectNewComponent } = loadService(`src/app/${entry}/project-new/project-new.component.ts`, window);
    const config = {
      init: async () => {},
      loadBoardList: async () => catalog,
      sortBoardsByUsage: list => [...list],
    };
    const electron = { isElectron: true };
    const project = { generateUniqueProjectName: () => 'new-robot-project' };
    let remoteLookups = 0;
    const npm = { getPackageVersionList() { remoteLookups++; throw new Error('Unexpected registry lookup'); } };
    const platform = { getPlatformSeparator: () => path.sep, isMac: () => false };
    const cloud = {
      getPublicProjects: () => rxjs.of({ status: 200, data: { total: 0 } }),
      getMyTemplates: () => rxjs.of({ status: 200, data: { list: [] } }),
    };
    const cd = { detectChanges() {} };
    const message = { error(text) { assert.fail(text); } };
    const component = entry === 'pages'
      ? new ProjectNewComponent({}, {}, electron, project, config, npm, platform, cloud, cd,
        { currentLang: 'en', instant: key => key }, message)
      : new ProjectNewComponent(electron, project, config, npm, {}, platform, cloud, cd, message);
    try {
      await component.ngOnInit();
      assert.equal(component.currentBoard.name, deviceName);
      assert.equal(component.newProjectData.board.sourcePath, devicePath);
      assert.equal(component.newProjectData.name, 'new-robot-project');
      if (entry === 'pages') assert.equal(component.newProjectData.devmode, 'arduino', 'preserve the project pipeline identifier');
      await component.nextStep();
      assert.equal(component.currentStep, 1);
      assert.equal(component.boardVersionList.length, 1);
      assert.equal(component.boardVersionList[0], catalog[0].version);
      assert.equal(remoteLookups, 0);

      if (entry === 'pages') {
        component.doSearch('crazyflie');
        assert.equal(component.boardList[0].name, deviceName);
        component.doSearch('unavailable-device-xyz');
        assert.equal(component.boardList.length, 0);
        assert.equal(component.currentBoard, null);
        component.doSearch('');
        assert.equal(component.currentBoard.name, deviceName);
      } else {
        component.search('crazyflie');
        assert.equal(component.boardList[0].name, deviceName);
        component.search('unavailable-device-xyz');
        assert.equal(component.boardList.length, 0);
        component.search('');
        assert.equal(component.boardList[0].name, deviceName);
      }
      assert.equal(JSON.stringify(catalog), original, 'search and selection must not mutate the shared catalog');
    } finally {
      component.ngOnDestroy?.();
    }
  }
});

test('device and AI caches replace stale development boards without network requests', async () => {
  const { ConfigService } = loadService('src/app/services/config.service.ts');
  const config = Object.create(ConfigService.prototype);
  const writes = new Map();
  config.boardList = [{ name: '@aily-project/board-arduino_uno' }];
  config.boardIndex = [...config.boardList];
  config.http = { get() { throw new Error('Unexpected board network request'); } };
  config.electronService = {
    readFile() { throw new Error('Legacy device cache must not control the catalog'); },
    writeFile: (filename, value) => writes.set(filename, JSON.parse(value)),
  };
  await config.loadAndCacheBoardList('appdata');
  await config.loadAndCacheBoardIndex('appdata');
  assert.deepEqual(Object.keys(config.boardDict), [deviceName]);
  assert.equal(config.boardList.length, 1);
  assert.equal(config.boardIndex[0].name, deviceName);
  assert.equal(writes.get('appdata/boards.json')[0].name, deviceName);
  assert.equal(writes.get('appdata/boards-index.json').boards.length, 1);
});

test('missing local resources clear stale UI and AI catalogs and notify the user', async () => {
  const window = desktop({ missing: [path.join(devicePath, 'package.json')] });
  const { ConfigService } = loadService('src/app/services/config.service.ts', window);
  const config = Object.create(ConfigService.prototype);
  const errors = [];
  config.boardList = [{ name: deviceName }];
  config.boardDict = { [deviceName]: {} };
  config.boardIndex = [{ name: deviceName }];
  config.showBoardLoadError = message => errors.push(message);
  config.showBoardIndexLoadError = message => errors.push(message);
  assert.equal((await config.loadBoardList()).length, 0);
  assert.equal((await config.loadBoardIndex()).length, 0);
  assert.deepEqual(Object.keys(config.boardDict), []);
  assert.equal(config.boardIndex.length, 0);
  assert.equal(errors.length, 2);
  assert.ok(errors.every(message => /missing/.test(message)));
});

test('unsupported new, template and switch requests fail before filesystem or install side effects', async () => {
  const { service, effects, errors } = project({});
  const input = { name: 'test', path: 'projects', board: { name: '@aily-project/board-arduino_uno' } };
  assert.equal(await service.projectNew(input), false);
  assert.equal(await service.projectNewFromTemplate(input, 'invalid'), false);
  await assert.rejects(service.changeBoard(input.board), /ROBOTSTEM.UNSUPPORTED_DEVICE/);
  assert.equal(errors.length, 3);
  assert.equal(effects.filter(([name]) => name !== 'footer').length, 0);
});

test('supported project creation copies the local template and activates it, including AI-origin requests', async () => {
  for (const fromCloudTemplate of [false, true]) {
    const window = desktop();
    const { service, effects, errors } = project(window);
    const input = { name: 'Robot Mission', path: 'projects', devmode: 'micropython',
      board: { name: deviceName, version: '0.0.1' } };
    const options = { activationReason: 'chat-tool-create' };
    const result = fromCloudTemplate
      ? await service.projectNewFromTemplate(input, templatePath, options)
      : await service.projectNew(input, options);
    assert.equal(result, true);
    assert.equal(errors.length, 0);
    const created = path.join('projects', 'Robot_Mission');
    const manifest = JSON.parse(window.writes.get(`${created}/package.json`));
    assert.equal(manifest.dependencies[deviceName], '0.0.1');
    assert.equal(manifest.devmode, 'micropython');
    const activation = effects.find(([kind]) => kind === 'open')[1];
    assert.equal(activation.data.path, created);
    assert.equal(activation.data.reason, 'chat-tool-create');
  }
});

test('invalid cloud templates and missing local packages cannot create partial projects', async () => {
  const invalidTemplate = desktop({ overrides: new Map([[path.join(templatePath, 'package.json'), '{}']]) });
  const cloud = project(invalidTemplate);
  const input = { name: 'test', path: 'projects', board: { name: deviceName } };
  assert.equal(await cloud.service.projectNewFromTemplate(input, templatePath), false);
  assert.equal(cloud.effects.filter(([name]) => name === 'mkdir').length, 0);
  const local = project(desktop({ missing: [path.join(devicePath, 'package.json')] }));
  assert.equal(await local.service.projectNew(input), false);
  assert.equal(local.effects.filter(([name]) => name === 'mkdir').length, 0);
});

test('switching uses the local Crazyflie package and preserves non-board dependencies', async () => {
  const window = desktop();
  const { service, effects, errors } = project(window);
  service.currentProjectPathSubject = new rxjs.BehaviorSubject('');
  service.currentProjectPath = 'existing-project';
  service.save = async () => effects.push(['save']);
  service.configService = { recordBoardUsage() {} };
  service.getBoardModule = async () => '@aily-project/board-arduino_uno';
  service.cmdService.runAsyncChecked = async command => effects.push(['command', command]);
  service.appDataResourceLock = { runExclusive: async (_key, action) => action() };
  service.getPackageJson = async () => ({ name: 'existing', dependencies: { helper: '1', '@aily-project/board-arduino_uno': '1' } });
  service.copyPackageJsonToTemp = async () => effects.push(['sync-temp']);
  service.projectOpen = async () => effects.push(['reload']);
  service.boardChangeSubject = { next: () => effects.push(['board-change']) };
  await service.changeBoard({ name: deviceName, version: '0.0.1' });
  assert.equal(errors.length, 0);
  const commands = effects.filter(([name]) => name === 'command').map(([, command]) => command);
  assert.equal(commands.length, 3);
  assert.ok(commands[1].includes(`"${devicePath}"`));
  assert.ok(commands[2].includes(`"${devicePath}"`));
  const manifest = JSON.parse(window.writes.get('existing-project/package.json'));
  assert.equal(manifest.dependencies[deviceName], '0.0.1');
  assert.equal(manifest.dependencies.helper, '1');
  assert.equal(manifest.dependencies['@aily-project/board-arduino_uno'], undefined);
  assert.equal(effects.filter(([name]) => name === 'reload').length, 1);
});

test('RobotSTEM branding has an independent desktop identity and preserves OAuth identifiers', () => {
  const metadata = require(path.join(root, 'package.json'));
  assert.equal(metadata.productName, 'RobotSTEM');
  const { APP_ID, configureDesktopIdentity } = require('../electron/desktop-identity');
  assert.equal(metadata.build.appId, APP_ID);
  assert.equal(metadata.build.publish, null);
  assert.ok(metadata.build.protocols.some(protocol => protocol.schemes.includes('ailyblockly')));
  const paths = {};
  let name;
  configureDesktopIdentity({
    setName: value => { name = value; },
    getPath: key => { assert.equal(key, 'appData'); return 'app-data'; },
    setPath: (key, value) => { paths[key] = value; },
    setAppUserModelId: value => { assert.equal(value, APP_ID); },
  }, 'win32');
  assert.equal(name, 'RobotSTEM');
  assert.equal(paths.userData, path.join('app-data', 'RobotSTEM'));
  assert.match(read('src/index.html'), /<title>RobotSTEM<\/title>/);
  assert.match(read('src/app/app.component.ts'), /title = 'RobotSTEM'/);
  for (const filename of ['public/robotstem.png', 'public/robotstem.ico', 'public/robotstem.svg']) {
    assert.ok(fs.statSync(path.join(root, filename)).size > 100);
  }
  const png = fs.readFileSync(path.join(root, 'public', 'robotstem.png'));
  assert.equal(png.readUInt32BE(16), 512);
  assert.equal(png.readUInt32BE(20), 512);
  const ico = fs.readFileSync(path.join(root, 'public', 'robotstem.ico'));
  assert.equal(ico.readUInt16LE(2), 1);
  assert.equal(ico.readUInt16LE(4), 1);
  assert.equal(ico.readUInt32LE(18), 22);
  assert.equal(ico.readUInt32BE(38), 256);
});

test('renderer automatic updates do not register timers or contact a provider', () => {
  const { UpdateService } = loadService('src/app/services/update.service.ts', { updater: new Proxy({}, {
    get() { throw new Error('The old updater must not be accessed'); },
  }) });
  const notices = [];
  const service = new UpdateService({ isElectron: true }, { info: data => notices.push(data) }, {}, { instant: key => key });
  service.init();
  assert.equal(service.updateStatus.value, 'disabled');
  service.checkForUpdates();
  assert.equal(notices[0].nzContent, 'ROBOTSTEM.UPDATE_UNAVAILABLE');
});

test('Electron rejects update checks, downloads and installation before configuring the old provider', () => {
  const handlers = new Map();
  const events = new Map();
  const statuses = [];
  const module = { exports: {} };
  vm.runInNewContext(read('electron/updater.js'), {
    module, exports: module.exports, __dirname: path.join(root, 'electron'), console: quiet,
    require: name => {
      if (name === 'electron') return { ipcMain: {
        handle: (name, action) => handlers.set(name, action),
        on: (name, action) => events.set(name, action),
      } };
      if (name === 'electron-updater') return { autoUpdater: new Proxy({}, {
        get() { throw new Error('Unexpected upstream provider access'); },
        set() { throw new Error('Unexpected upstream provider configuration'); },
      }) };
      if (name === '../package.json') return require(path.join(root, 'package.json'));
      if (name === 'fs' || name === 'path') return require(name);
      return {};
    },
  });
  module.exports.registerUpdaterHandlers({ webContents: { send: (_name, status) => statuses.push(status) } });
  assert.throws(() => handlers.get('check-for-updates')(), /independent update source/);
  assert.throws(() => handlers.get('start-download')(), /independent update source/);
  events.get('quit-and-install')();
  assert.equal(statuses.length, 3);
  assert.ok(statuses.every(status => status.status === 'error'));
});

test('both packaging flavors keep regional metadata but never inject an upstream publish URL', async () => {
  for (const flavor of ['cn', 'global']) {
    const invocations = [];
    let packaged;
    await vm.runInNewContext(`${read('scripts/build-electron.js')}\nmain(['--flavor', ${JSON.stringify(flavor)}]);`, {
      __dirname: path.join(root, 'scripts'), console: quiet, module: { exports: {} },
      process: { platform: 'win32', arch: 'x64', env: {}, execPath: 'node' },
      require: name => {
        if (name === 'node:child_process') return {
          spawnSync: (_command, args, options) => { invocations.push({ args, options }); return { status: 0 }; },
        };
        if (name === '@electron/rebuild') return { rebuild: async () => {} };
        if (name === 'electron-builder') return {
          Arch: { x64: 0 }, Platform: { WINDOWS: { createTarget: () => new Map() } },
          build: async options => { packaged = options; return ['RobotSTEM.exe']; },
        };
        return require(name);
      },
    });
    assert.equal(invocations.length, 1);
    assert.equal(invocations[0].options.env.AILY_BUILD_FLAVOR, flavor);
    assert.equal(packaged.publish, 'never');
    assert.equal(packaged.config.extraMetadata.ailyBuildFlavor, flavor);
    assert.ok(packaged.config.win.artifactName.startsWith('RobotSTEM'));
    assert.equal(packaged.config.publish, undefined);
    assert.equal(require(path.join(root, 'package.json')).build.publish, null);
  }
});

test('every shipped language includes all RobotSTEM labels without changing account or AI namespaces', () => {
  const keys = ['DEVICE', 'SELECT_DEVICE', 'SEARCH_DEVICES', 'DEVICE_DOCS', 'DEVICE_HINT', 'DEVICE_UNAVAILABLE',
    'UNSUPPORTED_DEVICE', 'AI_HINT', 'SOURCE_HINT', 'CREDITS', 'UPDATE_UNAVAILABLE'];
  const languages = fs.readdirSync(path.join(root, 'public', 'i18n'), { withFileTypes: true })
    .filter(entry => entry.isDirectory()).map(entry => entry.name);
  assert.equal(languages.length, 11);
  for (const language of languages) {
    const data = JSON.parse(read(`public/i18n/${language}/${language}.json`));
    for (const key of keys) assert.ok(data.ROBOTSTEM[key]?.trim(), `${language}: ${key}`);
    assert.equal(data.GUIDE.TITLE, 'RobotSTEM');
    assert.ok(data.AILY_CHAT);
    assert.ok(data.LOGIN);
  }
});

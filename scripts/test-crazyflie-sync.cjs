const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { spawnSync } = require('node:child_process');
const { test } = require('node:test');
const ts = require('typescript');

const root = path.resolve(__dirname, '..');
const services = path.join(root, 'src', 'app', 'services');
const generators = path.join(root, 'src', 'app', 'editors', 'blockly-editor', 'components',
  'blockly', 'generators', 'crazyflie');
const bridgeWindow = {};
const cache = new Map();
function load(filename) {
  if (cache.has(filename)) return cache.get(filename);
  const exports = {};
  const code = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022,
      experimentalDecorators: true, esModuleInterop: true },
  }).outputText;
  vm.runInNewContext(code, {
    exports, window: bridgeWindow, document: { getElementsByTagName: () => [] },
    performance, setTimeout: (...args) => setTimeout(...args), clearTimeout: token => clearTimeout(token), console,
    require: name => {
      if (name === '@angular/core') return {
        Injectable: () => type => type, Component: () => type => type,
        HostListener: () => () => {}, ViewChild: () => () => {},
        HostBinding: () => () => {}, Output: () => () => {}, EventEmitter: class { emit() {} },
        ChangeDetectionStrategy: { OnPush: 0 },
      };
      if (['three', 'rxjs', 'blockly', 'blockly/blocks', 'blockly/python'].includes(name)) return require(name);
      if (name.endsWith('/crazyflie-attitude')) return load(path.join(services, 'crazyflie-attitude.ts'));
      if (name.endsWith('/crazyflie-classroom')) return load(path.join(services, 'crazyflie-classroom.ts'));
      if (name.endsWith('/crazyflie-exploration')) return load(path.join(services, 'crazyflie-exploration.ts'));
      if (name.endsWith('/crazyflie-geography')) return require('./helpers/load-crazyflie-data.cjs')(path.join(services, 'crazyflie-geography.ts'));
      if (name.endsWith('/motion-blocks')) return load(path.join(generators, 'motion-blocks.ts'));
      if (name.endsWith('/radio-blocks')) return load(path.join(generators, 'radio-blocks.ts'));
      if (name.endsWith('/basic-blocks')) return load(path.join(generators, 'basic-blocks.ts'));
      return {};
    },
  });
  cache.set(filename, exports);
  return exports;
}
const attitude = load(path.join(services, 'crazyflie-attitude.ts'));
const { CrazyflieSimService } = load(path.join(services, 'crazyflie-sim.service.ts'));
const { CrazyflieRuntimeService } = load(path.join(services, 'crazyflie-runtime.service.ts'));
const { _UploaderService } = load(path.join(root, 'src', 'app', 'editors', 'blockly-editor',
  'services', 'uploader.service.ts'));
const motion = load(path.join(generators, 'motion-blocks.ts'));
const sample = (timestampMs, extra = {}) => ({
  type: 'sample', timestampMs, roll: 2, pitch: -3, yaw: 0, x: 0, y: 0, z: 0, ...extra,
});
const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-6, `${a} != ${b}`);
const plain = value => JSON.parse(JSON.stringify(value));
const simulator = () => new CrazyflieSimService({ setDeckDetected() {} });

test('exactly three modes cycle without a sequential simulation gate', () => {
  const runtime = new CrazyflieRuntimeService();
  assert.equal(runtime.policy$.value, 'sim-only');
  assert.equal(runtime.cyclePolicy(), 'sim-real');
  assert.equal(runtime.cyclePolicy(), 'real-only');
  assert.equal(runtime.cyclePolicy(), 'sim-only');
  const header = fs.readFileSync(path.join(root, 'src', 'app', 'main-window', 'components',
    'header', 'header.component.html'), 'utf8');
  assert.equal((header.match(/setCrazyflieRuntimeMode\('/g) || []).length, 3);
  assert.doesNotMatch(header, /sim-first|仿真通过后实飞/);
});

test('firmware XYZ maps to the same body frame as simulated motion at nonzero initial headings', () => {
  const origin = { x: 0, y: 0.76573, z: 0, yaw: 0 };
  const reference = sample(0, { x: 8, y: 9, z: 2, yaw: 90 });
  const pose = attitude.relativeFlightPose(
    sample(50, { x: 7.7, y: 9.5, z: 2.2, yaw: 180 }), reference, origin);
  near(pose.x, -0.5);
  near(pose.z, 0.3);
  near(pose.y, origin.y + 0.2);
  near(pose.yaw, Math.PI / 2);
  const turnedOrigin = { ...origin, yaw: Math.PI / 2 };
  const turned = attitude.relativeFlightPose(sample(50, { x: 1 }), sample(0), turnedOrigin);
  near(turned.x, 0);
  near(turned.z, 1);
  near(attitude.relativeFlightPose(sample(50, { yaw: -179 }), sample(0, { yaw: 179 }), origin).yaw,
    Math.PI / 90);
  assert.equal(attitude.isFlightPoseSample(sample(0)), true);
  for (const invalid of [{ x: NaN }, { y: null }, { z: Infinity }, { yaw: '1' }]) {
    assert.equal(attitude.isFlightPoseSample(sample(1, invalid)), false);
  }
});

test('real-follow lifecycle aligns the first frame, rebases estimator resets, holds the last sample and guards reset/scene/run', async () => {
  const sim = simulator();
  const origin = { ...sim.pose$.value };
  sim.beginRealFollow();
  assert.equal(sim.running$.value, true);
  assert.equal(sim.poseSource$.value, 'real');
  assert.throws(() => sim.resetPose(), /复位/);
  assert.throws(() => sim.setRoomPreset('home'), /切换/);
  assert.equal((await sim.runCode('cf_print("blocked")')).success, false);
  sim.receiveRealPose(sample(0, { x: 20, y: 30, z: 2 }), 0);
  assert.deepEqual(plain(sim.pose$.value), origin);
  sim.receiveRealPose(sample(50, { x: 20.5, y: 30.3, z: 2.2 }), 50);
  near(sim.pose$.value.x, -0.5);
  near(sim.pose$.value.z, 0.3);
  near(sim.pose$.value.y, origin.y + 0.2);
  const beforeReset = { ...sim.pose$.value };
  sim.resetRealReference();
  sim.receiveRealPose(sample(100), 100);
  assert.deepEqual(plain(sim.pose$.value), beforeReset);
  sim.receiveRealPose(sample(150, { x: 0.1 }), 150);
  near(sim.pose$.value.x, -0.6);
  assert.throws(() => sim.receiveRealPose({ ...sample(200), x: 'bad' }, 200), /XYZ/);
  assert.equal(sim.realReception.metrics(651).stale, true);
  const last = plain(sim.pose$.value);
  sim.endRealFollow('done');
  sim.receiveRealPose(sample(250, { x: 100 }), 250);
  assert.deepEqual(plain(sim.pose$.value), last);
  assert.equal(sim.running$.value, false);
  assert.equal(sim.followingReal$.value, false);
  sim.resetPose();
  assert.equal(sim.poseSource$.value, 'simulation');
  assert.equal(sim.realAttitude$.value, null);
  assert.deepEqual(plain(sim.pose$.value), origin);
});

test('legacy/new project toolbox merges in either load order and hides only redundant flyout entries', () => {
  const legacy = JSON.parse(fs.readFileSync(path.join(root, 'child', 'boards', 'board-crazyflie',
    'template', 'node_modules', '@aily-project', 'lib-crazyflie-motion', 'toolbox.json'), 'utf8'));
  const builtIn = motion.createCrazyflieMotionToolbox(false);
  const collect = item => [item.type, ...(item.contents || []).flatMap(collect)].filter(Boolean);
  for (const [incoming, existing] of [[legacy, builtIn], [builtIn, legacy]]) {
    const merged = motion.mergeCrazyflieFlightToolbox(incoming, existing);
    assert.equal(merged.name, 'Crazyflie');
    assert.equal(merged.categoryId, 'crazyflie-motion');
    assert.equal(merged.colour, '#4a87c6');
    assert.deepEqual(plain(merged.contents.slice(0, 4).map(item => item.type)), [
      'cf_crazyflie_link', 'cf_test_crazyflie_link', 'cf_takeoff', 'cf_land',
    ]);
    const types = collect(merged);
    for (const type of ['cf_delay', 'cf_print_text', 'cf_print', 'cf_test_link', 'cf_link_config']) {
      assert.ok(!types.includes(type));
    }
    for (const type of ['cf_crazyflie_link', 'cf_takeoff', 'cf_land', 'cf_takeoff_at',
      'cf_move_at_speed', 'cf_detect_multiranger', 'cf_detect_led_ring']) assert.ok(types.includes(type), type);
    const topTypes = merged.contents.filter(item => item.type).map(item => item.type);
    assert.equal(new Set(topTypes).size, topTypes.length);
    const repeated = motion.mergeCrazyflieFlightToolbox(legacy, merged);
    assert.equal(collect(repeated).length, types.length);
  }
  const definitions = JSON.parse(fs.readFileSync(path.join(root, 'child', 'boards', 'board-crazyflie',
    'template', 'node_modules', '@aily-project', 'lib-crazyflie-motion', 'block.json'), 'utf8'));
  for (const type of ['cf_delay', 'cf_print_text', 'cf_print']) {
    assert.ok(definitions.some(block => block.type === type), `retain saved block ${type}`);
  }
});

test('compact scene UI places all eleven scenes directly after basic examples, with no removed controls and one camera reset', () => {
  const panelPath = path.join(root, 'src', 'app', 'editors', 'blockly-editor', 'components',
    'blockly', 'components', 'crazyflie-sim-panel');
  const html = fs.readFileSync(path.join(panelPath, 'crazyflie-sim-panel.component.html'), 'utf8');
  assert.doesNotMatch(html, /导入平面图|导入3D模型|清除贴图|清除3D模型|togglePause|stepOnce|onSpeedChanged|setExplosionAmount|type="file"/);
  assert.equal((html.match(/click\)="resetCameraView\(\)"/g) || []).length, 1);
  const select = /<select class="sim-scene-select"[\s\S]+?<\/select>/.exec(html)[0];
  const { CRAZYFLIE_SCENE_OPTIONS } = load(path.join(services, 'crazyflie-exploration.ts'));
  assert.deepEqual(plain(CRAZYFLIE_SCENE_OPTIONS.map(scene => scene.id)),
    ['classroom', 'home', 'animals', 'botanical', 'science', 'space', 'ocean', 'beach', 'farm', 'china', 'world']);
  assert.match(select, /\*ngFor="let scene of sceneOptions" \[value\]="scene\.id"/);
  assert.match(select, /\[selected\]="scene\.id === simService\.roomPreset\$\.value"/);
  assert.match(select, /scene\.nameKey \| translate/);
  assert.match(select, /\[disabled\]="running"/);
  assert.match(select, /\[value\]="simService\.roomPreset\$\.value"/);
  assert.match(select, /\(change\)="onPresetSelected\(\$event\)"/);
  const toolbar = html.slice(html.indexOf('<div class="sim-panel__toolbar">'), html.indexOf('<div class="sim-panel__controls">'));
  assert.doesNotMatch(toolbar, /sim-scene-select/);
  const controls = html.slice(html.indexOf('<div class="sim-panel__controls">'), html.indexOf('<div class="sim-panel__canvas-wrap">'));
  assert.match(controls, /<button\b[^>]*\[nzDropdownMenu\]="examplesMenu"[^>]*>[\s\S]*?<\/button>\s*<select class="sim-scene-select"/);
  assert.equal((html.match(/class="sim-scene-select"/g) || []).length, 1);
});

function toolboxLoader() {
  const Blockly = require('blockly');
  const { BlocklyService } = load(path.join(root, 'src', 'app', 'editors', 'blockly-editor',
    'services', 'blockly.service.ts'));
  for (const spec of motion.motionBlocks) delete Blockly.Blocks[spec.type];
  const loader = Object.create(BlocklyService.prototype);
  Object.defineProperty(loader, 'workspace', { value: null, writable: true });
  let updates = 0;
  Object.assign(loader, {
    translateService: { currentLang: 'zh_cn' }, toolbox: { contents: [] },
    findToolboxItemIndex: () => -1, ensureToolboxItemIds() {}, applyToolboxSortOrderToContents() {},
    rebuildToolboxFacade() {}, syncToolboxFacadeWithWorkspace() {},
    workspace: {
      render() {},
      updateToolbox(toolbox) {
        updates++;
        const ws = new Blockly.Workspace();
        try {
          for (const block of toolbox.contents.filter(motion.isCrazyflieFlightToolbox)
            .flatMap(category => category.contents)
            .filter(item => motion.motionBlocks.some(spec => spec.type === item.type))) {
            Blockly.serialization.workspaces.load({
              blocks: { languageVersion: 0, blocks: [{ type: block.type, inputs: block.inputs }] },
            }, ws);
          }
        } finally { ws.dispose(); }
      },
    },
  });
  return { loader, updates: () => updates };
}

test('toolbox loading registers motion and number shadows before the first workspace update', () => {
  const { loader, updates } = toolboxLoader();
  loader.loadLibToolbox(motion.createCrazyflieMotionToolbox(true));
  assert.equal(updates(), 1);
});

test('refreshing basic categories registers existing motion entries before any workspace update', () => {
  const { loader, updates } = toolboxLoader();
  loader.translateService = { currentLang: 'zh-CN' };
  loader.toolbox.contents.push(motion.createCrazyflieMotionToolbox(true));
  loader.loadCrazyflieBasicBlocks();
  assert.equal(updates(), 7);
  assert.deepEqual(plain(loader.toolbox.contents.slice(-2).map(item => item.name)), ['Crazyflie', 'Crazyradio']);
  const radioCategory = loader.toolbox.contents.at(-1);
  assert.deepEqual(plain(radioCategory.contents.map(item => item.type)),
    ['cf_test_link', 'cf_scan_links', 'cf_radio_config']);
});

test('Crazyflie block language follows Settings and ignores the retired independent preference', () => {
  const { loader } = toolboxLoader();
  const oldStorage = bridgeWindow.localStorage;
  bridgeWindow.localStorage = { getItem() { throw new Error('independent block language must not be read'); } };
  try {
    for (const [locale, expected] of [['zh_cn', 'zh'], ['zh_hk', 'zh'], ['zh-CN', 'zh'], ['en', 'en'], ['de', 'en']]) {
      loader.translateService.currentLang = locale;
      assert.equal(loader.crazyflieBlockLanguage, expected);
    }
    loader.translateService.currentLang = undefined;
    loader.translateService.getDefaultLang = () => 'zh_cn';
    assert.equal(loader.crazyflieBlockLanguage, 'zh');
    loader.translateService.getDefaultLang = () => 'en';
    assert.equal(loader.crazyflieBlockLanguage, 'en');
    assert.equal(loader.setCrazyflieBlockLanguage, undefined);
  } finally { bridgeWindow.localStorage = oldStorage; }
});

test('toolbox has no separate language control and its deck labels use app translations', () => {
  const pane = path.join(root, 'src', 'app', 'editors', 'blockly-editor', 'components', 'blockly',
    'components', 'blockly-toolbox-pane');
  const html = fs.readFileSync(path.join(pane, 'blockly-toolbox-pane.component.html'), 'utf8');
  const source = fs.readFileSync(path.join(pane, 'blockly-toolbox-pane.component.ts'), 'utf8');
  const service = fs.readFileSync(path.join(root, 'src', 'app', 'editors', 'blockly-editor',
    'services', 'blockly.service.ts'), 'utf8');
  assert.doesNotMatch(html + source, /deck-language-toggle|toggleCrazyflieBlockLanguage|languageSwitching/);
  assert.doesNotMatch(service, /aily-crazyflie-block-language|setCrazyflieBlockLanguage/);
  assert.match(html, /deck\.name \| translate/);
  assert.doesNotMatch(html + source, /crazyflieIntroExpanded|deck\.expanded|deck\.description|onCrazyflieToggleClick/);
  assert.doesNotMatch(html, /crazyflie-intro|deck-row__content|deck-row__chevron/);
  assert.match(html, /\$implicit: cf, flat: true/);
  assert.match(html, /item\.isCollapsible && !flat/);
  const keys = [...new Set([...(html + source).matchAll(/'(CRAZYFLIE_TOOLBOX\.[A-Z0-9_.]+)'/g)].map(match => match[1]))];
  assert.ok(keys.length >= 6);
  const languages = JSON.parse(fs.readFileSync(path.join(root, 'public', 'i18n', 'i18n.json'), 'utf8'));
  for (const { code: lang } of languages) {
    const data = JSON.parse(fs.readFileSync(path.join(root, 'public', 'i18n', lang, `${lang}.json`), 'utf8'));
    for (const key of keys) {
      const value = key.split('.').reduce((value, part) => value?.[part], data);
      assert.equal(typeof value, 'string', `${lang}: ${key}`);
      assert.ok(value.trim().length > 0);
    }
    if (lang.startsWith('zh')) {
      const labels = data.CRAZYFLIE_TOOLBOX;
      assert.equal(labels.FLOW_V2.NAME, '光流定位');
      assert.equal(labels.DECKS, lang === 'zh_cn' ? '扩展' : '擴展');
      assert.equal(labels.MULTIRANGER.NAME, lang === 'zh_cn' ? '多向测距' : '多向測距');
      assert.equal(labels.LED_RING.NAME, lang === 'zh_cn' ? 'LED 灯环' : 'LED 燈環');
      assert.equal(labels.BUZZER.NAME, lang === 'zh_cn' ? '蜂鸣器' : '蜂鳴器');
      assert.doesNotMatch(JSON.stringify(labels), /甲板/);
    }
  }
});

test('Settings broadcasts only after its language change completes', async () => {
  const { SettingsComponent } = load(path.join(root, 'src', 'app', 'windows', 'settings', 'settings.component.ts'));
  const oldIpc = bridgeWindow.ipcRenderer;
  let finish;
  const events = [];
  bridgeWindow.ipcRenderer = { send: (...args) => events.push(plain(args)) };
  const settings = Object.create(SettingsComponent.prototype);
  settings.translationService = { setLanguage: code => {
    assert.equal(code, 'en');
    return new Promise(resolve => { finish = resolve; });
  } };
  try {
    const pending = settings.selectLang({ code: 'en' });
    assert.equal(events.length, 0);
    finish();
    await pending;
    assert.deepEqual(events, [['setting-changed', { action: 'language-changed', data: 'en' }]]);
  } finally { bridgeWindow.ipcRenderer = oldIpc; }
});

test('Settings language reload waits for translation and saved workspace, and never reloads a failed save', async () => {
  const { MainWindowComponent } = load(path.join(root, 'src', 'app', 'main-window', 'main-window.component.ts'));
  const { Subject } = require('rxjs');
  const oldIpc = bridgeWindow.ipcRenderer;
  for (const saveSucceeds of [true, false]) {
    const component = Object.create(MainWindowComponent.prototype);
    const events = [], errors = [];
    let handler, finishLanguage, finishSave;
    bridgeWindow.ipcRenderer = { on: (channel, callback) => {
      assert.equal(channel, 'setting-changed'); handler = callback;
    } };
    Object.assign(component, {
      uiService: { init() {}, updateFooterState() {} },
      updateService: { init() {} }, npmService: { init() {} }, cd: { detectChanges() {} },
      router: { url: '/main/blockly-editor?path=test', events: new Subject() },
      onboardingService: { show$: new Subject(), config$: new Subject() },
      configService: { load: async () => { events.push('config'); } },
      translate: { instant: key => key },
      translationService: { setLanguage: code => {
        events.push(`language:${code}`);
        return new Promise(resolve => { finishLanguage = resolve; });
      } },
      projectService: {
        currentProjectPath: 'test-project', init() {},
        save: () => { events.push('save'); return new Promise(resolve => { finishSave = resolve; }); },
        projectOpen: async (target, options) => {
          assert.equal(target, 'test-project'); assert.equal(options.reason, 'reload'); events.push('reload');
        },
      },
      message: { error: text => errors.push(text) },
    });
    try {
      component.ngOnInit();
      const pending = handler({}, { action: 'language-changed', data: 'en' });
      await new Promise(resolve => setImmediate(resolve));
      assert.deepEqual(events, ['config', 'language:en']);
      finishLanguage();
      await new Promise(resolve => setImmediate(resolve));
      assert.deepEqual(events, ['config', 'language:en', 'save']);
      finishSave({ success: saveSucceeds, error: 'test save failed' });
      await pending;
      assert.equal(events.includes('reload'), saveSucceeds);
      assert.deepEqual(errors, saveSucceeds ? [] : ['test save failed']);
    } finally { bridgeWindow.ipcRenderer = oldIpc; }
  }
});

test('flight and radio categories are separated from basic blocks with a themed accessible divider', () => {
  const pane = path.join(root, 'src', 'app', 'editors', 'blockly-editor', 'components', 'blockly',
    'components', 'blockly-toolbox-pane');
  const html = fs.readFileSync(path.join(pane, 'blockly-toolbox-pane.component.html'), 'utf8');
  const style = fs.readFileSync(path.join(pane, 'blockly-toolbox-pane.component.scss'), 'utf8');
  assert.match(html, /class="flight-toolbox-divider" role="separator"/);
  assert.ok(html.indexOf('flight-toolbox-divider') < html.indexOf('crazyflieRootItem as cf'));
  assert.ok(html.indexOf('crazyradioRootItem') > html.indexOf('crazyflieRootItem as cf'));
  assert.match(style, /\.flight-toolbox-divider\s*\{[^}]*border-top: 1px solid var\(--aily-border-input\)/);
});

test('flat aircraft and module rows select normal flyouts without expanding descriptions', () => {
  const { BlocklyToolboxPaneComponent } = load(path.join(root, 'src', 'app', 'editors',
    'blockly-editor', 'components', 'blockly', 'components', 'blockly-toolbox-pane',
    'blockly-toolbox-pane.component.ts'));
  const selected = [], errors = [];
  const pane = new BlocklyToolboxPaneComponent({ selectToolboxFacadeItem: key => selected.push(key) },
    {}, {}, {}, {}, {}, {}, { error: text => errors.push(text) }, { instant: key => key }, {});
  const child = (key, name) => ({ key, name, level: 1, selectable: true, children: [] });
  const aircraft = { key: 'cf', name: 'Crazyflie', level: 0, selectable: true, isCollapsible: true,
    children: [child('flow', 'Flow deck v2'), child('mr', 'Multiranger deck'),
      child('led', 'LED-ring deck'), child('sound', 'Buzzer deck')] };
  pane.items = [child('variables', 'Variables'), aircraft];
  pane.refreshDeckBindings(pane.items);
  pane.onFlightCategoryClick(aircraft);
  for (const deck of pane.deckGroups) {
    pane.onDeckRowClick(deck.key);
    pane.onDeckRowClick(deck.key);
    assert.equal('expanded' in deck, false);
    assert.equal('description' in deck, false);
  }
  assert.deepEqual(selected, ['cf', 'flow', 'flow', 'mr', 'mr', 'led', 'led', 'sound', 'sound']);
  pane.dragSorting = true;
  pane.onFlightCategoryClick(aircraft);
  pane.onDeckRowClick('flow-v2');
  assert.equal(selected.length, 9, 'a completed drag must not open a category');
  pane.dragSorting = false;
  pane.deckGroups[0].allTargetKey = null;
  pane.onDeckRowClick('flow-v2');
  assert.deepEqual(errors, ['CRAZYFLIE_TOOLBOX.UNAVAILABLE']);
});

test('removing the legacy library retains built-in Crazyradio definitions and generators', () => {
  const { loader } = toolboxLoader();
  loader.loadLibToolbox(motion.createCrazyflieMotionToolbox(true));
  loader.blockDefinitionsMap = new Map();
  loader.blockTypeToLibMap = new Map();
  loader.loadedGenerators = new Map([['legacy-generator', new Set(['cf_test_link', 'cf_link_config'])]]);
  const { crazyflieGenerator } = load(path.join(generators, 'basic-blocks.ts'));
  bridgeWindow.MPY = crazyflieGenerator;
  loader.removeLibBlocks([{ type: 'cf_test_link' }, { type: 'cf_link_config' }]);
  loader.removeLibGenerator('legacy-generator');
  for (const type of ['cf_test_link', 'cf_link_config']) {
    assert.ok(require('blockly').Blocks[type], type);
    assert.equal(typeof crazyflieGenerator.forBlock[type], 'function', type);
  }
});

test('legacy flight blocks use concise bilingual labels and the motion palette without changing deck colours', () => {
  const { loader } = toolboxLoader();
  const definitions = JSON.parse(fs.readFileSync(path.join(root, 'child', 'boards', 'board-crazyflie',
    'template', 'node_modules', '@aily-project', 'lib-crazyflie-motion', 'block.json'), 'utf8'));
  const original = JSON.stringify(definitions);
  const Blockly = require('blockly');
  for (const [language, labels] of [
    ['zh', ['连接', '检测无线收发器', '自检']],
    ['en', ['Connect', 'Check radio', 'Self-test']],
  ]) {
    loader.translateService.currentLang = language;
    const translated = loader.applyCrazyflieBlockLanguage(definitions);
    for (const [index, type] of ['cf_crazyflie_link', 'cf_test_link', 'cf_test_crazyflie_link'].entries()) {
      assert.equal(translated.find(block => block.type === type).message0, labels[index]);
    }
    if (language === 'zh') {
      for (const [type, message] of [
        ['cf_detect_flow_v2', '探测光流定位'], ['cf_detect_multiranger', '探测多向测距'],
        ['cf_detect_led_ring', '探测 LED 灯环'], ['cf_detect_buzzer', '探测蜂鸣器'],
      ]) {
        const definition = translated.find(block => block.type === type);
        assert.equal(definition.message0, message);
        assert.doesNotMatch(definition.tooltip, /甲板/);
      }
    }
    Blockly.defineBlocksWithJsonArray(translated);
    load(path.join(generators, 'radio-blocks.ts')).registerCrazyradioBlocks(
      load(path.join(generators, 'basic-blocks.ts')).crazyflieGenerator, language === 'zh');
    motion.registerCrazyflieMotionBlocks(load(path.join(generators, 'basic-blocks.ts')).crazyflieGenerator,
      language === 'zh');
    const workspace = new Blockly.Workspace();
    try {
      for (const type of ['cf_link_config', 'cf_crazyflie_link', 'cf_test_link', 'cf_test_crazyflie_link',
        'cf_takeoff', 'cf_land', ...motion.motionBlocks.map(spec => spec.type)]) {
        assert.equal(workspace.newBlock(type).getColour(), '#4a87c6', type);
      }
      const multiranger = translated.find(block => block.type === 'cf_detect_multiranger');
      assert.equal(multiranger.colour, definitions.find(block => block.type === multiranger.type).colour);
    } finally { workspace.dispose(); }
  }
  assert.equal(JSON.stringify(definitions), original, 'do not rewrite installed project definitions');
});

test('Settings language changes preserve motion fields, connections, IDs and generated Python', () => {
  const { loader } = toolboxLoader();
  const Blockly = require('blockly');
  const { crazyflieGenerator } = load(path.join(generators, 'basic-blocks.ts'));
  const radio = load(path.join(generators, 'radio-blocks.ts'));
  const saved = { blocks: { languageVersion: 0, blocks: [{
    type: 'cf_radio_config', id: 'radio', fields: { RADIO: 1, CHANNEL: 42, RATE: '1M', ADDRESS: 'ABCDEF1234' },
    next: { block: {
      type: 'cf_move_at_speed', id: 'move', fields: { DIRECTION: 'right' },
      inputs: {
        DISTANCE: { shadow: { type: 'math_number', fields: { NUM: 0.6 } } },
        SPEED: { shadow: { type: 'math_number', fields: { NUM: 0.25 } } },
      },
    } },
  }] } };
  let python;
  for (const locale of ['zh_cn', 'en', 'zh_hk', 'en']) {
    loader.translateService.currentLang = locale;
    const chinese = loader.crazyflieBlockLanguage === 'zh';
    radio.registerCrazyradioBlocks(crazyflieGenerator, chinese);
    motion.registerCrazyflieMotionBlocks(crazyflieGenerator, chinese);
    const workspace = new Blockly.Workspace();
    try {
      Blockly.serialization.workspaces.load(saved, workspace);
      const code = crazyflieGenerator.workspaceToCode(workspace);
      if (python === undefined) python = code;
      assert.equal(code, python, `${locale}: language must not change flight instructions`);
      const move = workspace.getBlockById('move');
      assert.equal(move.getFieldValue('DIRECTION'), 'right');
      assert.equal(move.getInputTargetBlock('DISTANCE').getFieldValue('NUM'), 0.6);
      assert.equal(move.getInputTargetBlock('SPEED').getFieldValue('NUM'), 0.25);
      assert.equal(workspace.getBlockById('radio').getNextBlock().id, 'move');
    } finally { workspace.dispose(); }
  }
});

test('Crazyflie hides duplicate generic buttons and routes menu/F6 run through the selected mode', async () => {
  const { HeaderComponent } = load(path.join(root, 'src', 'app', 'main-window', 'components',
    'header', 'header.component.ts'));
  const header = Object.create(HeaderComponent.prototype);
  header.canShowSimulatorControls = () => true;
  assert.equal(header.shouldShowHeaderButton({ action: 'compile' }), false);
  assert.equal(header.shouldShowHeaderButton({ action: 'upload' }), false);
  assert.equal(header.shouldShowHeaderButton({ action: 'other' }), true);
  let runs = 0;
  header.runSelectedCrazyflieMode = async () => { runs++; };
  await header.onClick({ action: 'upload' }, {});
  assert.equal(runs, 1);
  header.canShowSimulatorControls = () => false;
  assert.equal(header.shouldShowHeaderButton({ action: 'compile' }), true);
  assert.equal(header.shouldShowHeaderButton({ action: 'upload' }), true);
});

test('header groups flight controls by the radio and keeps the simulator toggle next to code viewing', () => {
  const headerDir = path.join(root, 'src', 'app', 'main-window', 'components', 'header');
  const html = fs.readFileSync(path.join(headerDir, 'header.component.html'), 'utf8');
  const radio = html.indexOf('class="cf-radio-selector"');
  const runtime = html.indexOf('class="cf-runtime-control"');
  const spacer = html.indexOf('class="null-box drag"');
  const toggle = html.indexOf('cf-simulator-toggle');
  assert.ok(radio < runtime && runtime < spacer && spacer < toggle);
  assert.ok(toggle < html.indexOf('@for (app of headerApps;'));
  assert.match(html, /\[style\.width\.px\]="boardControlsWidth"/);
  assert.doesNotMatch(html, /\{\{\s*radio\.serial\s*\}\}/);
  assert.match(html, /\[ngValue\]="radio\.serial"/);
  assert.match(html, /\[ngValue\]="connectionState\.radioSerial"/);
  assert.match(html, /\[attr\.aria-pressed\]="simulatorPanelVisible"/);
  const scss = fs.readFileSync(path.join(headerDir, 'header.component.scss'), 'utf8');
  assert.doesNotMatch(scss, /font-size:\s*11px/);
  assert.match(scss, /\.cf-mode-label/);
  const blockly = fs.readFileSync(path.join(root, 'src', 'app', 'editors', 'blockly-editor',
    'components', 'blockly', 'blockly.component.ts'), 'utf8');
  assert.match(blockly, /this\.uiService\.blocklyToolboxWidth = nextWidth/);
});

test('header uses simple radio names while retaining serial-based selection and responsive alignment', () => {
  const { HeaderComponent } = load(path.join(root, 'src', 'app', 'main-window', 'components',
    'header', 'header.component.ts'));
  const header = Object.create(HeaderComponent.prototype);
  Object.assign(header, {
    uiService: { blocklyToolboxWidth: 185 },
    router: { url: '/main/blockly-editor' },
    platformService: { isMac: () => false },
    crazyflieConnectionService: { selectedRadioSerial: 'AABBCCDD0002' },
    connectionState: { status: 'disconnected', message: '', radioSerial: 'AABBCCDD0001' },
  });
  header.canShowSimulatorControls = () => true;
  assert.equal(header.crazyradioLabel(0), 'Crazyradio 1');
  assert.equal(header.crazyradioLabel(1), 'Crazyradio 2');
  assert.equal(header.crazyradioLabel(), 'Crazyradio');
  assert.equal(header.boardControlsWidth, 185);
  header.uiService.blocklyToolboxWidth = 260;
  assert.equal(header.boardControlsWidth, 260);
  header.platformService.isMac = () => true;
  assert.equal(header.boardControlsWidth, 180);
  header.isMacFullScreen = true;
  assert.equal(header.boardControlsWidth, 260);
  header.platformService.isMac = () => false;
  header.router.url = '/main/code-editor';
  assert.equal(header.boardControlsWidth, null);
  header.router.url = '/main/blockly-editor';
  header.canShowSimulatorControls = () => false;
  assert.equal(header.boardControlsWidth, null);
  assert.match(header.crazyradioSelectorTooltip, /AABBCCDD0002/);
  header.selectCrazyradio('AABBCCDD0001');
  assert.equal(header.selectedCrazyradio, 'AABBCCDD0001');
  header.crazyradioDiscoveryError = 'USB enumeration failed';
  assert.equal(header.crazyradioSelectorTooltip, 'USB enumeration failed');
  header.crazyradioDiscoveryError = null;
  header.selectCrazyradio('');
  assert.match(header.crazyradioSelectorTooltip, /AABBCCDD0001/);
  header.connectionState.radioSerial = undefined;
  assert.equal(header.crazyradioSelectorTooltip, '选择无线收发器');
});

test('footer centers the current Crazyflie project name with nickname preference and full-name tooltip', async () => {
  const { FooterComponent } = load(path.join(root, 'src', 'app', 'main-window', 'components',
    'footer', 'footer.component.ts'));
  const footer = Object.create(FooterComponent.prototype);
  Object.assign(footer, {
    projectService: { currentPackageData: { name: 'project_oct16a', nickname: 'Flight class' },
      currentBoardConfig: { name: 'Crazyflie' } },
    router: { url: '/main/blockly-editor' },
  });
  assert.equal(footer.showCrazyflieTelemetry, true);
  assert.equal(footer.projectName, 'Flight class');
  delete footer.projectService.currentPackageData.nickname;
  assert.equal(footer.projectName, 'project_oct16a');
  footer.projectService.currentPackageData = null;
  assert.equal(footer.projectName, '');
  footer.projectService.currentBoardConfig.name = 'Arduino';
  assert.equal(footer.showCrazyflieTelemetry, false);
  const html = fs.readFileSync(path.join(root, 'src', 'app', 'main-window', 'components',
    'footer', 'footer.component.html'), 'utf8');
  const { parseTemplate } = await import('@angular/compiler');
  assert.equal(parseTemplate(html, 'footer.component.html').errors, null);
  assert.match(html, /showCrazyflieTelemetry && projectName/);
  assert.match(html, /\[title\]="projectName"/);
  assert.match(html, /\[class.footer-box--with-telemetry\]="showCrazyflieTelemetry"/);
  const styles = require('sass').compile(path.join(root, 'src', 'app', 'main-window', 'components',
    'footer', 'footer.component.scss')).css;
  assert.doesNotMatch(styles, /\.btn \.project-name/);
  assert.match(styles, /\.project-name__text\s*\{[^}]*text-overflow: ellipsis/);
  assert.match(styles, /\.footer-box--with-telemetry\s*\{[^}]*grid-template-columns: minmax\(max-content, 1fr\) minmax\(0, 30%\) minmax\(max-content, 1fr\)/);
  assert.match(styles, /\.project-name\s*\{[^}]*grid-column: 2;[^}]*justify-self: center/);
  assert.match(styles, /\.cf-footer-telemetry\s*\{[^}]*grid-column: 3/);
});

test('footer reserves separate fixed percentage and voltage widths with tabular digits', () => {
  const footer = path.join(root, 'src', 'app', 'main-window', 'components', 'footer', 'footer.component');
  const html = fs.readFileSync(`${footer}.html`, 'utf8');
  const styles = require('sass').compile(`${footer}.scss`).css;
  assert.match(html, /class="cf-footer-telemetry__value">{{ linkQuality \?\? '--' }}%/);
  assert.match(html, /class="cf-footer-telemetry__value">{{ batteryPercent \?\? '--' }}%<\/span>/);
  assert.match(html, /class="cf-footer-telemetry__voltage">· {{ batteryVolts }} V/);
  assert.match(styles, /\.cf-footer-telemetry__value\s*\{[^}]*width: calc\(3ch \+ 1em\)/);
  assert.match(styles, /\.cf-footer-telemetry__voltage\s*\{[^}]*width: calc\(5ch \+ 2em\)/);
  assert.match(styles, /\.cf-footer-telemetry__value,[\s\S]*?font-variant-numeric: tabular-nums/);
  assert.match(styles, /\.cf-footer-telemetry__bar\s*\{[^}]*flex: 0 0 52px/);
});

test('header automatically detects inserted radios every two seconds, pauses while connected and stops on teardown', async ({ mock }) => {
  mock.timers.enable({ apis: ['setTimeout'] });
  const { HeaderComponent } = load(path.join(root, 'src', 'app', 'main-window', 'components',
    'header', 'header.component.ts'));
  const header = Object.create(HeaderComponent.prototype);
  const errors = [];
  let scans = 0, checks = 0, activeProject = true, plugged = false, fail = false, pendingRead;
  const devices = { radios: [], async refreshRadios() {
    scans++;
    if (pendingRead) await pendingRead;
    if (fail) throw new Error('USB enumeration failed');
    this.radios = plugged ? [{ index: 0, serial: 'AABBCCDD0001' }] : [];
  } };
  Object.assign(header, {
    crazyflieConnectionService: devices, connectionState: { status: 'disconnected' },
    crazyflieRunInProgress: false, headerDestroyed: false, crazyradioDiscoveryError: null,
    crazyradioRefreshTimer: null, electronService: { isElectron: false },
    ngZone: { run: fn => fn(), runOutsideAngular: fn => fn() },
    cd: { markForCheck() { checks++; } }, message: { error: text => errors.push(text) },
    canShowSimulatorControls: () => activeProject,
  });
  const advance = async (ms = 2000) => {
    mock.timers.tick(ms);
    await new Promise(setImmediate);
  };
  await header.pollCrazyradios();
  assert.equal(scans, 1, 'initial detection does not require focusing the selector');
  plugged = true;
  await advance(1999);
  assert.equal(scans, 1);
  await advance(1);
  assert.equal(scans, 2);
  assert.equal(header.crazyradioInterfaces[0].serial, 'AABBCCDD0001');
  plugged = false;
  await advance();
  assert.equal(header.crazyradioInterfaces.length, 0, 'unplug removes the option without user interaction');
  const idleScans = scans;
  for (const status of ['checking', 'ready']) {
    header.connectionState.status = status;
    await advance();
    assert.equal(scans, idleScans, 'enumeration must not compete with the active radio link');
  }
  header.connectionState.status = 'disconnected';
  header.crazyflieRunInProgress = true;
  await advance();
  header.crazyflieRunInProgress = false;
  activeProject = false;
  await advance();
  assert.equal(scans, idleScans, 'other boards and running flows do not trigger background USB reads');
  activeProject = true;
  fail = true;
  await advance();
  await advance();
  assert.equal(errors.length, 1, 'repeated polling failures must not spam notifications');
  assert.match(header.crazyradioDiscoveryError, /USB enumeration failed/);
  fail = false;
  await advance();
  assert.equal(header.crazyradioDiscoveryError, null, 'a successful retry clears the visible error');
  let finishRead;
  pendingRead = new Promise(resolve => { finishRead = resolve; });
  await advance();
  const inFlight = scans;
  await advance(10000);
  assert.equal(scans, inFlight, 'slow enumeration does not create overlapping polling calls');
  const checksBeforeDestroy = checks;
  header.ngOnDestroy();
  finishRead();
  await new Promise(setImmediate);
  await advance(10000);
  assert.equal(scans, inFlight);
  assert.equal(checks, checksBeforeDestroy, 'a late enumeration cannot update a destroyed header');
  assert.equal(header.crazyradioRefreshTimer, null);
});

function uploaderHarness(run) {
  const sim = simulator();
  const notices = [];
  const errors = [];
  const listeners = new Set();
  let flowLog;
  let cancelled = 0;
  let plans = 0;
  let simulations = 0;
  const code = 'cf_crazyflie_link()\ncf_motion("takeoff", [0.3, 0.2])\ncf_motion("land", [0.2])';
  const api = {
    testLink: async () => ({ success: true }),
    startAttitude: async () => ({ success: true }),
    stopAttitude: async () => ({ success: true }),
    onAttitude: callback => { listeners.add(callback); return () => listeners.delete(callback); },
    onFlowLog: callback => { flowLog = callback; return () => { flowLog = null; }; },
    cancelFlow: async () => { cancelled++; return { success: true }; },
    runFlow: options => run({
      options, sim, emit: event => { for (const callback of listeners) callback(event); },
      log: line => flowLog?.({ line }),
    }),
  };
  bridgeWindow.crazyflie = api;
  bridgeWindow.electronAPI = { crazyflie: api };
  bridgeWindow.MPY = {};
  const uploader = Object.create(_UploaderService.prototype);
  Object.assign(uploader, {
    zone: { run: fn => fn() }, crazyflieFlowActive: false, crazyflieCancelRequested: false,
    projectService: { getBoardModule: async () => '@aily-project/board-crazyflie' },
    serialService: { currentPortInfo: null }, crazyflieSimService: sim,
    crazyflieTelemetryService: { clear() {}, setTelemetry() {} },
    crazyflieConnectionService: {
      state$: new (require('rxjs').BehaviorSubject)({ status: 'unknown' }),
      setChecking() {}, setResult() {}, setDeckDetected() {},
    },
    noticeService: { update: notice => notices.push(notice) }, logService: { update() {} },
    message: { error: message => errors.push(message) },
    clearBlocklySelection() {}, highlightCrazyflieBlock() {},
    prepareCrazyflieFlow() { plans++; return { code, executionBlocks: [] }; },
  });
  sim.runCode = async () => { simulations++; return { success: true, executed: [] }; };
  return { uploader, sim, notices, errors, listeners, api,
    get cancelled() { return cancelled; }, get plans() { return plans; },
    get simulations() { return simulations; }, get flowLog() { return flowLog; } };
}

test('combined mode compiles once, executes once, follows telemetry during flight and releases subscriptions', async () => {
  const h = uploaderHarness(async ({ options, sim, emit, log }) => {
    assert.equal(options.followPosition, true);
    assert.equal(sim.followingReal$.value, true);
    emit(sample(0));
    emit(sample(50, { x: 0.5, y: 0.2, z: 0.3, yaw: 45 }));
    near(sim.pose$.value.x, -0.5);
    near(sim.pose$.value.z, 0.2);
    near(sim.pose$.value.y, 1.06573);
    log('__STEP__:2/3:takeoff');
    assert.equal(sim.step$.value.current, 2);
    return { success: true, executed: ['crazyflie_link'] };
  });
  const result = await h.uploader.runCrazyflieSimAndReal();
  assert.equal(result.state, 'done');
  assert.equal(h.plans, 1);
  assert.equal(h.simulations, 0, 'must not run an idealized simulation before flight');
  assert.equal(h.sim.followingReal$.value, false);
  assert.equal(h.sim.running$.value, false);
  assert.equal(h.sim.poseSource$.value, 'real');
  assert.equal(h.listeners.size, 0);
  assert.equal(h.flowLog, null);
});

test('combined mode ignores automatic idle RPY/error packets but still requires flow XYZ, preserving radio selection', async () => {
  const h = uploaderHarness(async ({ options, emit, sim }) => {
    assert.equal(options.radioId, 'AABBCCDD0002');
    emit({ type: 'sample', source: 'idle', timestampMs: 25, roll: 10, pitch: 5, yaw: 20 });
    emit({ type: 'error', source: 'idle', message: 'idle log ended' });
    assert.equal(h.cancelled, 0);
    assert.equal(sim.realAttitude$.value, null);
    emit(sample(50, { source: 'flow' }));
    return { success: true, executed: [] };
  });
  h.uploader.crazyflieConnectionService.selectedRadioSerial = 'AABBCCDD0002';
  assert.equal((await h.uploader.runCrazyflieSimAndReal()).state, 'done');
  assert.equal(h.cancelled, 0);
  const idleOnly = uploaderHarness(async ({ emit }) => {
    emit({ type: 'sample', source: 'idle', timestampMs: 25, roll: 10, pitch: 5, yaw: 20 });
    return { success: true, executed: [] };
  });
  assert.equal((await idleOnly.uploader.runCrazyflieSimAndReal()).state, 'error');
});
test('real-only does not start synchronization, while simulation does not call the flight bridge', async () => {
  let flights = 0;
  const h = uploaderHarness(async ({ options, sim }) => {
    flights++;
    assert.equal(options.followPosition, false);
    assert.equal(sim.poseSource$.value, 'simulation');
    assert.equal(h.listeners.size, 0);
    return { success: true, executed: [] };
  });
  assert.equal((await h.uploader.runCrazyflieRealOnly()).state, 'done');
  assert.equal((await h.uploader.simulateCrazyflie()).state, 'done');
  assert.equal(flights, 1);
  assert.equal(h.simulations, 1);
});

test('radio scans use the flow runner and configuration-only results never claim a verified connection', async () => {
  for (const [code, executed] of [
    ['cf_scan_links()', ['scan_links']],
    ['cf_set_link("radio://0/80/2M", "E7E7E7E7E7")', ['set_link:radio://0/80/2M:E7E7E7E7E7']],
  ]) {
    let runs = 0;
    const h = uploaderHarness(async ({ options }) => {
      runs++;
      assert.equal(options.code, code);
      return { success: true, executed, links: [] };
    });
    h.uploader.prepareCrazyflieFlow = () => ({ code, executionBlocks: [] });
    assert.equal((await h.uploader.runCrazyflieRealOnly()).state, 'done');
    assert.equal(runs, 1);
    if (executed[0].startsWith('set_link')) {
      assert.equal(h.uploader.crazyflieConnectionService.state$.value.status, 'unknown');
    }
  }
});

test('missing/invalid telemetry cannot return success and active cancellation waits for the flow to finish', async () => {
  for (const fault of ['missing', 'invalid', 'error', 'throw']) {
    const h = uploaderHarness(async ({ emit }) => {
      if (fault === 'invalid') emit({ ...sample(1), z: NaN });
      if (fault === 'error') emit({ type: 'error', message: 'no fresh data' });
      if (fault === 'throw') throw new Error('bridge failed');
      return { success: true, executed: [] };
    });
    if (fault === 'throw') await assert.rejects(h.uploader.runCrazyflieSimAndReal(), /bridge failed/);
    else assert.equal((await h.uploader.runCrazyflieSimAndReal()).state, 'error');
    assert.equal(h.sim.running$.value, false);
    assert.equal(h.listeners.size, 0);
    assert.equal(h.flowLog, null);
    if (fault === 'invalid' || fault === 'error') assert.equal(h.cancelled, 1);
  }
  let finish;
  const h = uploaderHarness(({ emit }) => {
    emit(sample(0));
    return new Promise(resolve => { finish = resolve; });
  });
  const running = h.uploader.runCrazyflieSimAndReal();
  await new Promise(resolve => setImmediate(resolve));
  h.uploader.cancel();
  assert.equal(h.cancelled, 1);
  assert.equal(h.sim.running$.value, true, 'do not claim a flying vehicle has already stopped');
  assert.equal((await h.uploader.runCrazyflieRealOnly()).state, 'error');
  finish({ success: true, executed: [] });
  assert.equal((await running).state, 'warn');
  assert.equal(h.sim.running$.value, false);

  const failedCancel = uploaderHarness(({ emit }) => {
    emit(sample(0));
    return new Promise(resolve => { finish = resolve; });
  });
  failedCancel.api.cancelFlow = async () => ({ success: false, message: 'control channel closed' });
  const active = failedCancel.uploader.runCrazyflieSimAndReal();
  await new Promise(resolve => setImmediate(resolve));
  failedCancel.uploader.cancel();
  await new Promise(resolve => setImmediate(resolve));
  assert.match(failedCancel.errors[0], /取消请求失败/);
  finish({ success: true, executed: [] });
  assert.equal((await active).state, 'error');
});

test('Python synchronized logger emits same-packet XYZ/RPY, gates missing data, tracks estimator resets and removes callbacks', () => {
  const result = spawnSync('py', ['-3', '-B', '-c', `
import sys, types, time
from threading import Event
from pathlib import Path
sys.path.insert(0, str(Path('child') / 'scripts'))
import crazyflie_attitude as observer
class Callback:
    def __init__(self): self.callbacks = []
    def add_callback(self, cb): self.callbacks.append(cb)
    def remove_callback(self, cb): self.callbacks.remove(cb)
    def call(self, *args):
        for cb in list(self.callbacks): cb(*args)
configs, samples = [], []
mode = ['ok']
class Config:
    def __init__(self, name, period_in_ms):
        self.data_received_cb, self.error_cb = Callback(), Callback()
        self.names, self.deleted = [], False
        configs.append(self)
    def add_variable(self, name, kind):
        assert kind == 'float'
        self.names.append(name)
    def start(self):
        data = dict(zip(['stabilizer.roll','stabilizer.pitch','stabilizer.yaw',
                         'stateEstimate.x','stateEstimate.y','stateEstimate.z'], [1,2,3,4,5,6]))
        if mode[0] == 'missing': del data['stateEstimate.x']
        self.data_received_cb.call(100, data, self)
    def stop(self): pass
    def delete(self): self.deleted = True
reset_callbacks = []
def add_update_callback(**kwargs): reset_callbacks.append(kwargs['cb'])
def remove_update_callback(**kwargs): reset_callbacks.remove(kwargs['cb'])
scf = types.SimpleNamespace(cf=types.SimpleNamespace(
    log=types.SimpleNamespace(add_config=lambda cfg: None), disconnected=Callback(),
    param=types.SimpleNamespace(add_update_callback=add_update_callback,
                               remove_update_callback=remove_update_callback)))
for name in ['cflib','cflib.crazyflie','cflib.crazyflie.log']:
    sys.modules[name] = types.ModuleType(name)
sys.modules['cflib.crazyflie.log'].LogConfig = Config
with observer.attitude_logging(scf, samples.append, follow_position=True) as healthy:
    healthy()
    assert samples[0] == dict(type='sample',timestampMs=100,roll=1,pitch=2,yaw=3,x=4,y=5,z=6), samples
    reset_callbacks[0]('kalman.resetEstimation', '0')
    assert samples[-1] == {'type':'reference'}
assert len(configs[-1].names) == 6 and configs[-1].deleted
assert not reset_callbacks and not scf.cf.disconnected.callbacks
mode[0] = 'missing'
try:
    with observer.attitude_logging(scf, samples.append, follow_position=True):
        raise AssertionError('missing XYZ was allowed to start flight')
except RuntimeError as error:
    assert 'Flight pose logging failed' in str(error), error
assert not reset_callbacks and configs[-1].deleted
print('pose logging gate and cleanup passed')
`], { cwd: root, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
});

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');
const ts = require('typescript');
const yaml = require('js-yaml');
const root = path.resolve(__dirname, '..');
const { options, buildConfig } = require('./build-electron.js');

test('native packaging validates platform, architecture and flavor without silently cross-building', () => {
  for (const [host, platform, arch] of [['win32', 'windows', 'x64'], ['linux', 'linux', 'x64'], ['darwin', 'macos', 'arm64']]) {
    const actual = options([], host, arch);
    assert.equal(actual.platform, platform);
    assert.equal(actual.arch, arch);
    assert.equal(actual.flavor, 'cn');
  }
  for (const args of [['--flavor', 'other'], ['--flavor'], ['--platform', 'macos'],
    ['--arch', 'arm64'], ['--arch', 'universal'], ['--unknown'], ['--all', '--arch', 'x64']]) {
    assert.throws(() => options(args, 'win32', 'x64'));
  }
  assert.equal(options(['--all', '--ref', 'RobotSTEM'], 'win32', 'x64').all, true);
  assert.throws(() => options([], 'win32', 'arm64'), /x64 only/);
});

test('each native installer has distinct architecture names, matching runtimes and all required device resources', () => {
  for (const [host, platform, arch] of [['win32', 'windows', 'x64'], ['linux', 'linux', 'x64'], ['darwin', 'macos', 'arm64']]) {
    const config = buildConfig(options([], host, arch), '/native/runtime');
    assert.ok(config.directories.output.includes(`${platform}-${arch}`));
    assert.deepEqual(config.win.target, ['nsis']);
    assert.deepEqual(config.mac.target, ['dmg', 'zip']);
    assert.deepEqual(config.linux.target, ['AppImage', 'deb']);
    for (const target of ['mac', 'linux']) {
      assert.equal(config[target].extraResources[0].from, '/native/runtime');
      assert.ok(config[target].artifactName.includes('${arch}'));
    }
    assert.equal(config.mac.icon, 'public/robotstem.png');
    const board = config.extraResources.find(item => item.to === 'child/boards/board-crazyflie');
    assert.ok(board, 'installed app must be able to load its real device catalog and project template');
    assert.ok(config.extraResources.find(item => item.to === 'child/scripts').filter.includes('!**/*.pyc'));
  }
});

test('legacy release commands preserve their output location and installer naming', () => {
  const config = buildConfig(options(['--flavor', 'global', '--legacy-output'], 'win32', 'x64'), '/runtime');
  assert.equal(config.directories.output, path.join('dist', 'aily-blockly'));
  assert.equal(config.nsis.artifactName, 'RobotSTEM-Setup-${version}.${ext}');
  const metadata = JSON.parse(fs.readFileSync(path.join(root, 'package.json')));
  assert.equal(metadata.build.win.sign, null);
  assert.equal(metadata.build.win.icon, 'public/robotstem.ico');
  assert.equal(metadata.build.mac.icon, 'public/robotstem.png');
  assert.ok(metadata.build.files.includes('LICENSE'));
  assert.ok(metadata.build.extraResources.some(item => item.to === 'child/boards/board-crazyflie'));
  assert.equal(metadata.devDependencies['@electron/rebuild'], '3.6.1');
});

test('one-command CI uses all four native runners and cannot execute the legacy release jobs', () => {
  const main = yaml.load(fs.readFileSync(path.join(root, '.github', 'workflows', 'main.yml'), 'utf8'));
  const native = yaml.load(fs.readFileSync(path.join(root, '.github', 'workflows', 'desktop-installers.yml'), 'utf8'));
  assert.equal(main.on.workflow_dispatch.inputs.installers_only.default, false);
  assert.equal(main.jobs['desktop-installers'].uses, './.github/workflows/desktop-installers.yml');
  for (const name of ['build-windows', 'build-windows-cn', 'build-macos', 'build-macos-cn']) {
    assert.equal(main.jobs[name].if, "github.event_name != 'workflow_dispatch' || !inputs.installers_only");
  }
  for (const name of ['build-windows', 'build-windows-cn', 'build-macos', 'build-macos-cn']) {
    assert.ok(main.jobs.release.needs.includes(name));
  }
  assert.ok(!main.jobs.release.if, 'release uses the default successful-dependencies gate');
  assert.ok(native.on.workflow_call);
  assert.equal(native.permissions.contents, 'read');
  assert.deepEqual(native.jobs.package.strategy.matrix.include.map(item => `${item.platform}-${item.arch}`),
    ['windows-x64', 'linux-x64', 'macos-arm64', 'macos-x64']);
  assert.equal(native.jobs.package.strategy.matrix.include[0].os, 'windows-2022');
  assert.equal(native.jobs.package.strategy['fail-fast'], false);
  assert.ok(native.jobs.package.steps.some(step => step.with?.['if-no-files-found'] === 'error'));
  assert.ok(native.jobs.package.steps.some(step => step.run?.includes('build:desktop')));
  assert.ok(native.jobs.package.env.NPM_CONFIG_ELECTRON_BUILDER_BINARIES_MIRROR.startsWith('https://github.com/'));
  assert.ok(native.jobs.package.steps.some(step => step.uses === 'actions/setup-python@v5' && step.with['python-version'] === '3.11'));
});

test('Ubuntu packages the standalone 7za executable rather than a missing 7zz or system-dependent wrapper', () => {
  const source = ts.createSourceFile('build-electron.js', fs.readFileSync(path.join(root, 'scripts', 'build-electron.js'), 'utf8'),
    ts.ScriptTarget.Latest, true);
  const prepare = source.statements.find(node => ts.isFunctionDeclaration(node) && node.name.text === 'prepareUnixRuntime');
  const declaration = prepare.body.statements.find(node => ts.isVariableStatement(node)
    && node.declarationList.declarations[0].name.getText(source) === 'sevenZip').declarationList.declarations[0];
  assert.equal(vm.runInNewContext(declaration.initializer.getText(source), {
    config: { platform: 'linux' }, fs: { existsSync: filename => filename === '/usr/lib/7zip/7za', realpathSync: filename => filename },
    capture: () => { throw new Error('Do not use the system wrapper'); },
  }), '/usr/lib/7zip/7za');
});

test('Mac downloads complete sevenzip licenses and source for the installed version, including bottle revisions', async () => {
  const source = ts.createSourceFile('build-electron.js', fs.readFileSync(path.join(root, 'scripts', 'build-electron.js'), 'utf8'),
    ts.ScriptTarget.Latest, true);
  const helper = source.statements.find(node => ts.isFunctionDeclaration(node) && node.name.text === 'bundleSevenZipSource');
  for (const version of ['26.02', '26.05_1']) {
    const downloads = [], stable = version.replace(/_\d+$/, '');
    await vm.runInNewContext(`${helper.getText(source)}; bundleSevenZipSource(binary, '/licenses/sevenzip');`, {
      binary: `/opt/homebrew/Cellar/sevenzip/${version}/bin/7zz`, path: path.posix, fs: { mkdirSync() {} },
      verifiedDownload: async (url, target) => { downloads.push([url, target]); },
    });
    assert.equal(downloads.length, 4);
    for (const name of ['License.txt', 'copying.txt', 'unRarLicense.txt']) {
      assert.ok(downloads.some(([url, target]) => url === `https://raw.githubusercontent.com/ip7z/7zip/${stable}/DOC/${name}`
        && target === `/licenses/sevenzip/${name}`));
    }
    assert.ok(downloads.some(([url]) => url.endsWith(`/refs/tags/${stable}.tar.gz`)));
  }
  await assert.rejects(vm.runInNewContext(`${helper.getText(source)}; bundleSevenZipSource('/usr/bin/7zz', '/licenses');`, {}),
    /Cannot determine installed Homebrew sevenzip version/);
});

test('Mac runtime relocates and signs shared Homebrew libraries once, including nested Ninja dependencies', () => {
  const source = ts.createSourceFile('build-electron.js', fs.readFileSync(path.join(root, 'scripts', 'build-electron.js'), 'utf8'),
    ts.ScriptTarget.Latest, true);
  const helper = source.statements.find(node => ts.isFunctionDeclaration(node) && node.name.text === 'bundleMacLibraries');
  const binary = '/opt/homebrew/Cellar/ripgrep/15/bin/rg';
  const ninja = '/opt/homebrew/Cellar/ninja/1/bin/ninja';
  const library = '/opt/homebrew/Cellar/pcre2/10/lib/libpcre2-8.0.dylib';
  const dependency = '/opt/homebrew/opt/pcre2/lib/libpcre2-8.0.dylib';
  const commands = [], copied = [], licensed = [];
  const invoke = dependencies => vm.runInNewContext(`${helper.getText(source)}; bundleMacLibraries(binaries, '/bundle', copyLicense);`, {
    path: path.posix, binaries: [[binary, '/bundle/rg'], [ninja, '/bundle/aily-builder/ninja/ninja']],
    copyLicense: file => licensed.push(file),
    fs: { realpathSync: file => file === dependency ? library : file,
      mkdirSync() {}, copyFileSync: (from, to) => copied.push([from, to]) },
    run: (command, args) => commands.push([command, ...args]),
    capture: (_command, [, file]) => `${file}:\n${(file === library ? [dependency, '/usr/lib/libSystem.B.dylib'] : dependencies)
      .map(item => `\t${item} (compatibility version 1.0.0, current version 1.0.0)`).join('\n')}`,
  });
  invoke([dependency, '/usr/lib/libSystem.B.dylib']);
  assert.deepEqual(copied, [[library, '/bundle/lib/libpcre2-8.0.dylib']]);
  assert.deepEqual(licensed, [library]);
  assert.ok(commands.some(args => args[0] === 'install_name_tool'
    && args[3] === '@loader_path/lib/libpcre2-8.0.dylib' && args[4] === '/bundle/rg'));
  assert.ok(commands.some(args => args[0] === 'install_name_tool'
    && args[3] === '@loader_path/../../lib/libpcre2-8.0.dylib' && args[4] === '/bundle/aily-builder/ninja/ninja'));
  assert.equal(commands.filter(args => args[0] === 'codesign').length, 3);
  assert.throws(() => invoke(['@rpath/unknown.dylib']), /Cannot relocate non-system library/);
});

function pythonCandidates(platform, env, exists = () => false) {
  const filename = path.join(root, 'electron', 'crazyflie.js');
  const source = ts.createSourceFile(filename, fs.readFileSync(filename, 'utf8'), ts.ScriptTarget.Latest, true);
  const functions = ['fileExists', 'getPythonCandidates'].map(name => source.statements.find(node =>
    ts.isFunctionDeclaration(node) && node.name.text === name).getText(source));
  return JSON.parse(JSON.stringify(vm.runInNewContext(`${functions.join('\n')}; getPythonCandidates()`,
    { process: { platform, env }, path: platform === 'win32' ? path.win32 : path.posix,
      fs: { existsSync: exists } })));
}

test('Unix installers find python3 and honor an existing explicit Python path, while Windows keeps its launcher', () => {
  for (const platform of ['linux', 'darwin']) {
    assert.deepEqual(pythonCandidates(platform, {}), ['python3', 'python']);
    assert.deepEqual(pythonCandidates(platform, { PYTHON: '/opt/venv/bin/python' }, file => file === '/opt/venv/bin/python'),
      ['/opt/venv/bin/python', 'python3', 'python']);
    assert.deepEqual(pythonCandidates(platform, { PYTHON: 'PYTHON3' }), ['python3', 'python']);
  }
  assert.deepEqual(pythonCandidates('win32', {}), ['py', 'python']);
});

test('installed Unix apps use node/bin and expand the Linux data directory to the actual home', () => {
  const filename = path.join(root, 'electron', 'main.js');
  const source = ts.createSourceFile(filename, fs.readFileSync(filename, 'utf8'), ts.ScriptTarget.Latest, true);
  const load = source.statements.find(node => ts.isFunctionDeclaration(node) && node.name.text === 'loadEnv');
  let nodePath, appData;
  function visit(node) {
    if (ts.isVariableDeclaration(node) && node.name.getText(source) === 'nodePath') nodePath = node.initializer;
    if (ts.isBinaryExpression(node) && node.left.getText(source) === 'process.env.AILY_APPDATA_PATH'
      && node.right.getText(source).includes('["linux"]')) appData = node.right;
    ts.forEachChild(node, visit);
  }
  visit(load);
  for (const isWin32 of [true, false]) {
    const paths = isWin32 ? path.win32 : path.posix;
    const childPath = isWin32 ? 'C:\\app\\resources\\child' : '/app/resources/child';
    assert.equal(vm.runInNewContext(nodePath.getText(source), { path: paths, childPath, isWin32 }),
      isWin32 ? 'C:\\app\\resources\\child\\node' : '/app/resources/child/node/bin');
  }
  assert.equal(vm.runInNewContext(appData.getText(source), {
    conf: { appdata_path: { linux: '~/.config/aily-project' } }, os: { homedir: () => '/home/test' },
  }), '/home/test/.config/aily-project');
});

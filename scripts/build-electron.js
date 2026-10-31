const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');

const workspaceRoot = path.resolve(__dirname, '..');
const platforms = { win32: 'windows', linux: 'linux', darwin: 'macos' };
const workflow = 'main.yml';

function options(args, host = process.platform, arch = process.arch) {
  const result = { flavor: 'cn', platform: platforms[host], arch, all: false, dryRun: false, legacyOutput: false, ref: '' };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--all') result.all = true;
    else if (args[i] === '--legacy-output') result.legacyOutput = true;
    else if (args[i] === '--dry-run') result.dryRun = true;
    else if (['--flavor', '--platform', '--arch', '--ref'].includes(args[i])) {
      if (!args[i + 1] || args[i + 1].startsWith('--')) throw new Error(`Missing value for ${args[i]}`);
      result[args[i].slice(2)] = args[++i];
    } else throw new Error(`Unknown build argument: ${args[i]}`);
  }
  if (!['cn', 'global'].includes(result.flavor)) throw new Error('Flavor must be cn or global');
  if (result.all && args.some(value => ['--platform', '--arch', '--legacy-output'].includes(value))) {
    throw new Error('--all uses the fixed native CI matrix; do not combine it with platform, architecture or legacy output flags');
  }
  if (!['windows', 'linux', 'macos'].includes(result.platform)) throw new Error('Unsupported platform');
  if (!['x64', 'arm64'].includes(result.arch)) throw new Error('Architecture must be x64 or arm64');
  if (!result.all && (result.platform !== platforms[host] || result.arch !== arch)) {
    throw new Error('Native modules require the matching OS and architecture. Use --all for native GitHub Actions builds.');
  }
  if (!result.all && result.platform === 'windows' && result.arch !== 'x64') {
    throw new Error('The bundled Windows toolchain currently supports x64 only');
  }
  return result;
}

function run(command, args, extra = {}) {
  const result = spawnSync(command, args, { cwd: workspaceRoot, stdio: 'inherit', ...extra });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${path.basename(command)} failed (${result.status ?? result.signal})`);
  return typeof result.stdout === 'string' ? result.stdout.trim() : '';
}
const capture = (command, args) => run(command, args, { stdio: ['ignore', 'pipe', 'inherit'], encoding: 'utf8' });

function buildConfig(config, runtimeDirectory) {
  const prefix = config.flavor === 'cn' ? 'RobotSTEM-CN' : 'RobotSTEM';
  const unixResources = [{ from: runtimeDirectory, to: 'child' }];
  return {
    extraMetadata: { ailyBuildFlavor: config.flavor },
    directories: { output: config.legacyOutput ? path.join('dist', 'aily-blockly')
      : path.join('dist', 'installers', `${config.platform}-${config.arch}`, config.flavor) },
    extraResources: [
      { from: 'child/scripts', to: 'child/scripts', filter: ['**/*', '!**/__pycache__/**', '!**/*.pyc'] },
      { from: 'child/boards/board-crazyflie', to: 'child/boards/board-crazyflie', filter: ['**/*', '!**/__pycache__/**', '!**/*.pyc'] },
      { from: 'public/robotstem.ico', to: 'icon.ico' },
      { from: 'electron/app-update.yml', to: 'app-update.yml' },
    ],
    win: { target: ['nsis'], artifactName: `${prefix}-windows-\${version}-\${arch}.\${ext}` },
    nsis: { artifactName: `${prefix}-Setup-\${version}${config.legacyOutput ? '' : '-\${arch}'}.\${ext}` },
    mac: { icon: 'public/robotstem.png', target: ['dmg', 'zip'], extraResources: unixResources,
      artifactName: `${prefix}-macos-\${version}-\${arch}.\${ext}` },
    linux: { icon: 'public/robotstem.png', executableName: 'robotstem', target: ['AppImage', 'deb'], extraResources: unixResources,
      artifactName: `${prefix}-linux-\${version}-\${arch}.\${ext}` },
  };
}

async function verifiedDownload(url, destination) {
  const response = await fetch(url, { signal: AbortSignal.timeout(180000) });
  if (!response.ok) throw new Error(`Download failed (${response.status}): ${url}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  fs.writeFileSync(destination, bytes);
  return bytes;
}

function bundleMacLibraries(binaries, directory, copyLicense) {
  const libraries = new Map();
  const relocate = (source, destination) => {
    const dependencies = capture('otool', ['-L', source]).split('\n').slice(1);
    for (const line of dependencies) {
      const dependency = /^\s+(.+?)\s+\(compatibility version /.exec(line)?.[1];
      if (!dependency || dependency.startsWith('/usr/lib/') || dependency.startsWith('/System/Library/')) continue;
      if (!path.isAbsolute(dependency)) throw new Error(`Cannot relocate non-system library ${dependency} for ${source}`);
      const filename = fs.realpathSync(dependency);
      if (filename === source) continue;
      const target = path.join(directory, 'lib', path.basename(filename));
      if (libraries.has(target) && libraries.get(target) !== filename) throw new Error(`Conflicting native library: ${target}`);
      if (!libraries.has(target)) {
        libraries.set(target, filename);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.copyFileSync(filename, target);
        copyLicense(filename);
        relocate(filename, target);
      }
      run('install_name_tool', ['-change', dependency, `@loader_path/${path.relative(path.dirname(destination), target)}`, destination]);
    }
    if (path.extname(destination) === '.dylib') run('install_name_tool', ['-id', `@rpath/${path.basename(destination)}`, destination]);
    run('codesign', ['--force', '--sign', '-', destination]);
  };
  for (const [source, destination] of binaries) relocate(source, destination);
}

async function prepareUnixRuntime(directory, config, environment) {
  fs.mkdirSync(directory, { recursive: true });
  const sevenZip = fs.realpathSync(capture('which', ['7zz']));
  const ripgrep = fs.realpathSync(capture('which', ['rg']));
  const ninja = fs.realpathSync(capture('which', ['ninja']));
  for (const [source, name] of [[sevenZip, '7zz'], [ripgrep, 'rg']]) {
    fs.copyFileSync(source, path.join(directory, name));
    fs.chmodSync(path.join(directory, name), 0o755);
  }
  const licenseRoot = path.join(directory, 'licenses');
  const copyLicenses = (docs, name) => {
    let copied = 0;
    const visit = (folder, depth = 0) => {
      for (const entry of fs.readdirSync(folder, { withFileTypes: true })) {
        const filename = path.join(folder, entry.name);
        if (entry.isFile() && /^(?:licen[sc]e|copying|copyright|notice)(?:[._-].*)?$/i.test(entry.name)) {
          const target = path.join(licenseRoot, name, path.relative(docs, filename));
          fs.mkdirSync(path.dirname(target), { recursive: true });
          fs.copyFileSync(filename, target);
          copied++;
        } else if (entry.isDirectory() && depth < 5 && !['bin', 'lib', 'node_modules'].includes(entry.name)) visit(filename, depth + 1);
      }
    };
    visit(docs);
    if (!copied) throw new Error(`Missing license for ${name}: ${docs}`);
  };
  const copyBrewLicense = filename => {
    const cellar = /[/]Cellar[/]([^/]+)[/]([^/]+)[/]/.exec(filename);
    if (!cellar) throw new Error(`Use a Homebrew installation so the license can be bundled: ${filename}`);
    copyLicenses(filename.slice(0, cellar.index) + cellar[0].slice(0, -1), cellar[1]);
  };
  for (const [binary, name] of [[sevenZip, '7zip'], [ripgrep, 'ripgrep'], [ninja, 'ninja-build']]) {
    if (config.platform === 'macos') copyBrewLicense(binary);
    else copyLicenses(path.join('/usr/share/doc', name), name);
  }
  if (config.platform === 'linux') fs.cpSync('/usr/share/common-licenses', path.join(licenseRoot, 'debian-common'), { recursive: true });
  const nodeBin = path.join(directory, 'node', 'bin');
  fs.mkdirSync(nodeBin, { recursive: true });
  fs.copyFileSync(process.execPath, path.join(nodeBin, 'node'));
  fs.chmodSync(path.join(nodeBin, 'node'), 0o755);
  const nodeLicense = path.join(path.dirname(path.dirname(process.execPath)), 'LICENSE');
  if (fs.existsSync(nodeLicense)) fs.copyFileSync(nodeLicense, path.join(directory, 'node', 'LICENSE'));
  else await verifiedDownload(`https://raw.githubusercontent.com/nodejs/node/v${process.versions.node}/LICENSE`,
    path.join(directory, 'node', 'LICENSE'));
  const npmCli = fs.realpathSync(process.env.npm_execpath || capture('which', ['npm']));
  const npmRoot = path.dirname(path.dirname(npmCli));
  if (JSON.parse(fs.readFileSync(path.join(npmRoot, 'package.json'), 'utf8')).name !== 'npm') {
    throw new Error('Cannot locate the native npm distribution; run npm run build:desktop');
  }
  fs.cpSync(npmRoot, path.join(directory, 'node', 'lib', 'node_modules', 'npm'), { recursive: true });
  for (const name of ['npm', 'npx']) fs.symlinkSync(`../lib/node_modules/npm/bin/${name}-cli.js`, path.join(nodeBin, name));

  const source = path.join(path.dirname(directory), 'builder-source');
  run(sevenZip, ['x', path.join(workspaceRoot, 'child', 'windows', 'aily-builder-1.2.0.7z'), `-o${source}`, '-y']);
  const builder = path.join(directory, 'aily-builder');
  fs.mkdirSync(builder);
  for (const name of ['index.js', 'aily-builder.js', 'package.json']) fs.copyFileSync(path.join(source, name), path.join(builder, name));
  const metadata = JSON.parse(fs.readFileSync(path.join(builder, 'package.json'), 'utf8'));
  metadata.dependencies = Object.fromEntries(['@ast-grep/napi', '@ast-grep/lang-cpp', 'tree-sitter', 'tree-sitter-cpp'].map(name => [
    name, JSON.parse(fs.readFileSync(path.join(source, 'node_modules', name, 'package.json'), 'utf8')).version,
  ]));
  fs.writeFileSync(path.join(builder, 'package.json'), JSON.stringify(metadata, null, 2));
  run(process.execPath, [npmCli, 'install', '--omit=dev', '--no-audit', '--no-fund'], { cwd: builder, env: environment });
  fs.mkdirSync(path.join(builder, 'ninja'));
  fs.copyFileSync(ninja, path.join(builder, 'ninja', 'ninja'));
  fs.chmodSync(path.join(builder, 'ninja', 'ninja'), 0o755);
  if (config.platform === 'macos') bundleMacLibraries([
    [sevenZip, path.join(directory, '7zz')], [ripgrep, path.join(directory, 'rg')],
    [ninja, path.join(builder, 'ninja', 'ninja')],
  ], directory, copyBrewLicense);
  for (const [command, args] of [
    [path.join(directory, '7zz'), ['i']], [path.join(directory, 'rg'), ['--version']],
    [path.join(builder, 'ninja', 'ninja'), ['--version']], [path.join(nodeBin, 'node'), ['--version']],
    [path.join(nodeBin, 'node'), [path.join(nodeBin, 'npm'), '--version']],
  ]) run(command, args, { env: environment });
  run(process.execPath, ['-e', `const p=${JSON.stringify(builder)};const a=require(p+'/node_modules/@ast-grep/napi');a.registerDynamicLanguage({cpp:require(p+'/node_modules/@ast-grep/lang-cpp')});a.parse('cpp','int main() { return 0; }');`]);

  const triple = `${config.arch === 'arm64' ? 'aarch64' : 'x86_64'}-${config.platform === 'macos' ? 'apple-darwin' : 'unknown-linux-gnu'}`;
  const archiveName = `probe-rs-tools-${triple}.tar.xz`;
  const base = 'https://github.com/probe-rs/probe-rs/releases/download/v0.31.0/';
  const archive = path.join(path.dirname(directory), archiveName);
  const bytes = await verifiedDownload(base + archiveName, archive);
  const checksumFile = path.join(path.dirname(directory), `${archiveName}.sha256`);
  const checksum = (await verifiedDownload(base + `${archiveName}.sha256`, checksumFile)).toString('utf8').trim().split(/\s+/)[0];
  if (!/^[a-f0-9]{64}$/i.test(checksum) || crypto.createHash('sha256').update(bytes).digest('hex') !== checksum.toLowerCase()) {
    throw new Error(`Checksum mismatch: ${archiveName}`);
  }
  const unpacked = path.join(path.dirname(directory), 'probe-source');
  fs.mkdirSync(unpacked);
  run('tar', ['-xJf', archive, '-C', unpacked]);
  const executable = path.join(unpacked, archiveName.replace('.tar.xz', ''), 'probe-rs');
  if (!fs.statSync(executable).isFile()) throw new Error('Downloaded probe-rs archive does not contain its executable');
  fs.cpSync(path.dirname(executable), path.join(directory, 'probe-rs'), { recursive: true });
  fs.chmodSync(path.join(directory, 'probe-rs', 'probe-rs'), 0o755);
}

function smokePackage(context, config) {
  const app = config.platform === 'macos' ? path.join(context.appOutDir, 'RobotSTEM.app', 'Contents') : context.appOutDir;
  const resources = path.join(app, config.platform === 'macos' ? 'Resources' : 'resources');
  const executable = config.platform === 'macos' ? path.join(app, 'MacOS', 'RobotSTEM')
    : path.join(app, config.platform === 'windows' ? 'RobotSTEM.exe' : 'robotstem');
  const modules = path.join(resources, 'app.asar', 'electron', 'node_modules');
  const code = `const fs=require('fs');require(${JSON.stringify(path.join(modules, 'serialport'))});require(${JSON.stringify(path.join(modules, '@lydell', 'node-pty'))});const r=${JSON.stringify(path.join(resources, 'app.asar', 'renderer', 'vision', 'gesture'))};for(const f of ['gesture_recognizer.task','vision_wasm_internal.wasm','vision_wasm_nosimd_internal.wasm'])if(!fs.existsSync(r+'/'+f))throw Error('Missing gesture asset '+f);const b=${JSON.stringify(path.join(resources, 'child', 'boards', 'board-crazyflie'))};for(const f of ['package.json','template/package.json'])if(!fs.existsSync(b+'/'+f))throw Error('Missing device template '+f);if(JSON.parse(fs.readFileSync(b+'/package.json')).name!=='@aily-project/board-crazyflie')throw Error('Invalid device metadata');console.log('Packaged native modules, device template and gesture assets verified');`;
  run(executable, ['-e', code], { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } });
}

async function buildAll(config) {
  const dirty = capture('git', ['status', '--porcelain', '--untracked-files=normal']).split('\n').filter(line =>
    line.trim() && !/child[\\/]scripts[\\/]__pycache__[\\/].*\.pyc"?$/.test(line));
  if (dirty.length) throw new Error('Commit and push the source changes first. CI does not build this uncommitted worktree.');
  const ref = config.ref || capture('git', ['branch', '--show-current']);
  if (!ref) throw new Error('Specify --ref when building from detached HEAD');
  const localSha = capture('git', ['rev-parse', 'HEAD']);
  const remoteSha = capture('gh', ['api', `repos/{owner}/{repo}/commits/${encodeURIComponent(ref)}`, '--jq', '.sha']);
  if (remoteSha !== localSha) throw new Error('The selected remote ref does not match local HEAD. Push before building.');
  const request = crypto.randomUUID();
  run('gh', ['workflow', 'run', workflow, '--ref', ref, '-f', 'installers_only=true', '-f', `flavor=${config.flavor}`, '-f', `request_id=${request}`]);
  const deadline = Date.now() + 180000;
  let id;
  while (!id && Date.now() < deadline) {
    const runs = JSON.parse(capture('gh', ['run', 'list', '--workflow', workflow, '--event', 'workflow_dispatch',
      '--limit', '30', '--json', 'databaseId,displayTitle']));
    id = runs.find(item => item.displayTitle.includes(request))?.databaseId;
    if (!id) await new Promise(resolve => setTimeout(resolve, 5000));
  }
  if (!id) throw new Error(`Cannot locate dispatched workflow ${request}; inspect GitHub Actions`);
  run('gh', ['run', 'watch', String(id), '--exit-status']);
  const destination = path.join(workspaceRoot, 'dist', 'installers', `ci-${id}`);
  run('gh', ['run', 'download', String(id), '--dir', destination]);
  console.log(`All platform installers: ${destination}`);
}

async function main(args = process.argv.slice(2)) {
  const config = options(args);
  if (config.dryRun) {
    console.log(JSON.stringify(config.all ? { mode: 'ci', workflow, flavor: config.flavor,
      platforms: ['windows-x64', 'linux-x64', 'macos-arm64', 'macos-x64'] } : buildConfig(config, '<native-runtime>'), null, 2));
    return;
  }
  if (config.all) return buildAll(config);
  const environment = { ...process.env, NODE_ENV: 'production', AILY_BUILD_FLAVOR: config.flavor };
  let temporary;
  try {
    let runtime = path.join(workspaceRoot, 'child', 'windows');
    if (config.platform !== 'windows') {
      temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'robotstem-package-'));
      runtime = path.join(temporary, 'child');
      await prepareUnixRuntime(runtime, config, environment);
    }
    const { rebuild } = require('@electron/rebuild');
    console.log(`Rebuilding Electron native dependencies for ${config.platform}/${config.arch}...`);
    await rebuild({ buildPath: path.join(workspaceRoot, 'electron'),
      electronVersion: require('electron/package.json').version, arch: config.arch });
    console.log('Building the production renderer...');
    run(process.execPath, [path.join(workspaceRoot, 'node_modules', '@angular', 'cli', 'bin', 'ng.js'),
      'build', '--base-href', './'], { env: environment });
    const { build, Platform, Arch } = require('electron-builder');
    const platform = { windows: Platform.WINDOWS, linux: Platform.LINUX, macos: Platform.MAC }[config.platform];
    const files = await build({ targets: platform.createTarget(undefined, Arch[config.arch]), publish: 'never',
      config: { ...buildConfig(config, runtime), afterPack: context => smokePackage(context, config) } });
    if (!files.length) throw new Error('The builder returned no installation artifacts');
    for (const file of files) console.log(`Installer: ${file}`);
  } finally {
    if (temporary) fs.rmSync(temporary, { recursive: true, force: true });
  }
}

module.exports = { options, buildConfig };
if (require.main === module) main().catch(error => { console.error('RobotSTEM packaging failed:', error); process.exitCode = 1; });
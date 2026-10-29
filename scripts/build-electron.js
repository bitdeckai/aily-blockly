const path = require('path');
const { spawnSync } = require('child_process');

const args = process.argv.slice(2);
const flavorIndex = args.indexOf('--flavor');
const requestedFlavor = flavorIndex >= 0 ? args[flavorIndex + 1] : 'cn';
const buildFlavor = requestedFlavor === 'global' ? 'global' : 'cn';
const artifactPrefix = buildFlavor === 'cn' ? 'RobotSTEM-CN' : 'RobotSTEM';
const workspaceRoot = path.resolve(__dirname, '..');

const builderArgs = [
  'build',
  `-c.extraMetadata.ailyBuildFlavor=${buildFlavor}`,
  '--publish', 'never',
  `-c.win.artifactName=${artifactPrefix}-\${version}.\${ext}`,
  `-c.nsis.artifactName=${artifactPrefix}-Setup-\${version}.\${ext}`,
  `-c.mac.artifactName=${artifactPrefix}-macos-\${version}-\${arch}.\${ext}`
];
const ngCliPath = path.join(workspaceRoot, 'node_modules', '@angular', 'cli', 'bin', 'ng.js');
const electronBuilderCliPath = path.join(workspaceRoot, 'node_modules', 'electron-builder', 'cli.js');

function run(commandArgs, extraEnv = {}) {
  const result = spawnSync(process.execPath, commandArgs, {
    stdio: 'inherit',
    cwd: workspaceRoot,
    env: {
      ...process.env,
      NODE_ENV: 'production',
      AILY_BUILD_FLAVOR: buildFlavor,
      AILY_BUILD_ARTIFACT_PREFIX: artifactPrefix,
      ...extraEnv
    }
  });

  if (result.error) {
    console.error(result.error);
    process.exit(1);
  }

  if (result.status !== 0) {
    process.exit(result.status || 1);
  }
}

run([ngCliPath, 'build', '--base-href', './']);
run([electronBuilderCliPath, ...builderArgs]);
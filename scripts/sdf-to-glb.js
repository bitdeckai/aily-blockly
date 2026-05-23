#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const CONVERTIBLE_EXTS = new Set(['.dae', '.obj', '.stl', '.fbx']);
const COPY_EXTS = new Set(['.glb', '.gltf']);

function parseArgs(argv) {
  const args = {
    sdf: '',
    outDir: '',
    blender: 'blender',
    modelRoots: [],
    merge: true,
    mergedName: '',
  };

  for (let i = 0; i < argv.length; i += 1) {
    const cur = argv[i];
    if (cur === '--sdf') {
      args.sdf = argv[++i] || '';
    } else if (cur === '--out-dir') {
      args.outDir = argv[++i] || '';
    } else if (cur === '--blender') {
      args.blender = argv[++i] || 'blender';
    } else if (cur === '--model-root') {
      const value = argv[++i] || '';
      if (value) {
        args.modelRoots.push(value);
      }
    } else if (cur === '--no-merge') {
      args.merge = false;
    } else if (cur === '--merged-name') {
      args.mergedName = argv[++i] || '';
    } else if (cur === '--help' || cur === '-h') {
      printHelp();
      process.exit(0);
    }
  }

  return args;
}

function printHelp() {
  console.log('SDF to GLB converter');
  console.log('Usage: npm run sdf:to-glb -- --sdf <path/to/model.sdf> [--out-dir <dir>] [--model-root <root>] [--blender <cmd>] [--no-merge] [--merged-name <name.glb>]');
  console.log('Example: npm run sdf:to-glb -- --sdf "E:/.../model.sdf" --model-root "E:/.../gazebo" --merged-name crazyflie.glb');
}

function extractUris(sdfText) {
  const uris = [];
  const regex = /<uri>\s*([^<]+?)\s*<\/uri>/g;
  let match;
  while ((match = regex.exec(sdfText)) !== null) {
    const value = String(match[1] || '').trim();
    if (value) {
      uris.push(value);
    }
  }
  return Array.from(new Set(uris));
}

function decodeFileUri(uri) {
  let val = uri.replace(/^file:\/\//i, '');
  if (/^\/[A-Za-z]:\//.test(val)) {
    val = val.slice(1);
  }
  return decodeURIComponent(val);
}

function resolveModelUri(uri, sdfDir, modelRoots) {
  const cleanRoots = Array.from(new Set(modelRoots.map((item) => path.resolve(item))));

  if (/^file:\/\//i.test(uri)) {
    const filePath = decodeFileUri(uri);
    return fs.existsSync(filePath) ? filePath : '';
  }

  if (uri.startsWith('model://')) {
    const tail = uri.slice('model://'.length);
    const firstSlash = tail.indexOf('/');
    const modelName = firstSlash > -1 ? tail.slice(0, firstSlash) : tail;
    const remainder = firstSlash > -1 ? tail.slice(firstSlash + 1) : '';

    for (const root of cleanRoots) {
      const p1 = path.join(root, modelName, remainder);
      if (fs.existsSync(p1)) {
        return p1;
      }
      const p2 = path.join(root, remainder);
      if (fs.existsSync(p2)) {
        return p2;
      }
    }
    return '';
  }

  const candidate = path.resolve(sdfDir, uri);
  return fs.existsSync(candidate) ? candidate : '';
}

function sanitizeName(filePath) {
  const parsed = path.parse(filePath);
  return parsed.name.replace(/[^a-zA-Z0-9._-]/g, '_') || 'mesh';
}

function runBlenderConvert(blenderCmd, scriptPath, inputPath, outPath) {
  const args = ['-b', '-P', scriptPath, '--', inputPath, outPath];
  const ret = spawnSync(blenderCmd, args, { encoding: 'utf8' });
  return {
    ok: ret.status === 0,
    status: ret.status,
    stdout: ret.stdout || '',
    stderr: ret.stderr || '',
    command: [blenderCmd, ...args].join(' '),
  };
}

function runBlenderMerge(blenderCmd, scriptPath, outputPath, inputGlbs) {
  const args = ['-b', '-P', scriptPath, '--', outputPath, ...inputGlbs];
  const ret = spawnSync(blenderCmd, args, { encoding: 'utf8' });
  return {
    ok: ret.status === 0,
    status: ret.status,
    stdout: ret.stdout || '',
    stderr: ret.stderr || '',
    command: [blenderCmd, ...args].join(' '),
  };
}

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function copyFile(src, dst) {
  ensureDir(path.dirname(dst));
  fs.copyFileSync(src, dst);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.sdf) {
    printHelp();
    throw new Error('Missing required --sdf argument.');
  }

  const sdfPath = path.resolve(args.sdf);
  if (!fs.existsSync(sdfPath)) {
    throw new Error(`SDF file not found: ${sdfPath}`);
  }

  const sdfDir = path.dirname(sdfPath);
  const outDir = path.resolve(args.outDir || path.join(sdfDir, 'converted_glb'));
  ensureDir(outDir);

  const sdfText = fs.readFileSync(sdfPath, 'utf8');
  const uris = extractUris(sdfText);

  const defaultRoots = [
    path.resolve(path.join(sdfDir, '..')),
    path.resolve(path.join(sdfDir, '..', '..')),
    sdfDir,
  ];
  const modelRoots = Array.from(new Set([...defaultRoots, ...args.modelRoots]));

  const blenderScriptPath = path.resolve(__dirname, 'blender-convert-to-glb.py');
  const blenderMergeScriptPath = path.resolve(__dirname, 'blender-merge-glb.py');
  const results = [];

  for (const uri of uris) {
    const resolved = resolveModelUri(uri, sdfDir, modelRoots);
    if (!resolved) {
      results.push({ uri, status: 'missing', reason: 'Cannot resolve uri path' });
      continue;
    }

    const ext = path.extname(resolved).toLowerCase();
    const outName = `${sanitizeName(resolved)}.glb`;
    const outPath = path.join(outDir, outName);

    if (COPY_EXTS.has(ext)) {
      if (ext === '.glb') {
        copyFile(resolved, outPath);
      } else {
        const converted = runBlenderConvert(args.blender, blenderScriptPath, resolved, outPath);
        if (!converted.ok) {
          results.push({ uri, resolved, status: 'failed', reason: 'gltf to glb conversion failed', detail: converted });
          continue;
        }
      }
      results.push({ uri, resolved, output: outPath, status: 'done', mode: ext === '.glb' ? 'copied' : 'converted' });
      continue;
    }

    if (!CONVERTIBLE_EXTS.has(ext)) {
      results.push({ uri, resolved, status: 'skipped', reason: `Unsupported extension ${ext}` });
      continue;
    }

    const converted = runBlenderConvert(args.blender, blenderScriptPath, resolved, outPath);
    if (!converted.ok) {
      results.push({ uri, resolved, status: 'failed', reason: 'blender conversion failed', detail: converted });
      continue;
    }
    results.push({ uri, resolved, output: outPath, status: 'done', mode: 'converted' });
  }

  let mergedOutput = '';
  let mergedResult = null;
  const doneOutputs = results
    .filter((item) => item.status === 'done' && item.output)
    .map((item) => path.resolve(item.output));
  const uniqueDoneOutputs = Array.from(new Set(doneOutputs));

  if (args.merge && uniqueDoneOutputs.length >= 2) {
    const base = path.parse(sdfPath).name;
    const mergedFileName = args.mergedName
      ? String(args.mergedName)
      : `${base}_combined.glb`;
    mergedOutput = path.join(outDir, mergedFileName.toLowerCase().endsWith('.glb') ? mergedFileName : `${mergedFileName}.glb`);
    mergedResult = runBlenderMerge(args.blender, blenderMergeScriptPath, mergedOutput, uniqueDoneOutputs);
  }

  const report = {
    sdf: sdfPath,
    outDir,
    blender: args.blender,
    mergeEnabled: args.merge,
    mergedOutput,
    mergedResult,
    modelRoots,
    scannedUriCount: uris.length,
    results,
  };

  const reportPath = path.join(outDir, 'sdf-convert-report.json');
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2), 'utf8');

  const done = results.filter((item) => item.status === 'done').length;
  const failed = results.filter((item) => item.status === 'failed').length;
  const missing = results.filter((item) => item.status === 'missing').length;
  const skipped = results.filter((item) => item.status === 'skipped').length;
  const mergeFailed = mergedResult && !mergedResult.ok;

  console.log(`SDF processed: ${sdfPath}`);
  console.log(`Output dir: ${outDir}`);
  console.log(`Done: ${done}, Failed: ${failed}, Missing: ${missing}, Skipped: ${skipped}`);
  if (args.merge) {
    if (uniqueDoneOutputs.length < 2) {
      console.log('Merge: skipped (requires at least 2 converted parts)');
    } else if (mergedResult?.ok) {
      console.log(`Merge: done -> ${mergedOutput}`);
    } else {
      console.log('Merge: failed');
    }
  }
  console.log(`Report: ${reportPath}`);

  if (failed > 0 || mergeFailed) {
    process.exitCode = 2;
  }
}

try {
  main();
} catch (error) {
  console.error(error?.message || String(error));
  process.exit(1);
}

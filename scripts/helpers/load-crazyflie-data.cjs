const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const cache = new Map();
function load(filename) {
  if (cache.has(filename)) return cache.get(filename);
  const exports = {};
  cache.set(filename, exports);
  const { outputText } = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  });
  vm.runInNewContext(outputText, { exports, require: name => {
    if (!name.startsWith('.')) return require(name);
    const target = path.resolve(path.dirname(filename), name);
    return name.endsWith('.json') ? require(target) : load(`${target}.ts`);
  } });
  return exports;
}
module.exports = load;

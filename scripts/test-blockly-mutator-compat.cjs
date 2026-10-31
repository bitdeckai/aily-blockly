const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');
const Blockly = require('blockly');
const plugin = path.join(__dirname, '..', 'src', 'app', 'editors', 'blockly-editor', 'components',
  'blockly', 'plugins', 'block-plus-minus', 'src');
const { outputFiles } = require('esbuild').buildSync({
  stdin: { contents: "import './if.js'; import './switch-case.js'; import './dynamic-inputs.js';", resolveDir: plugin },
  bundle: true, platform: 'node', format: 'cjs', write: false, external: ['blockly/core'],
});
vm.runInNewContext(outputFiles[0].text, { require, exports: {}, module: { exports: {} } });
Blockly.Blocks['compat_if'] = { init() {
  this.appendValueInput('IF0');
  this.appendStatementInput('DO0');
  this.appendStatementInput('ELSE');
  Blockly.Extensions.apply('controls_if_mutator', this, true);
} };
Blockly.Blocks['compat_switch'] = { init() {
  this.appendValueInput('CASE0');
  this.appendStatementInput('DO0');
  this.appendStatementInput('DEFAULT');
  Blockly.Extensions.apply('switch_case_mutator', this, true);
} };
Blockly.Blocks['compat_dynamic'] = { init() {
  this.appendValueInput('INPUT0');
  Blockly.Extensions.apply('dynamic_inputs_mutator', this, true);
} };

test('upstream conditional compatibility preserves removal of a default ELSE in JSON and XML round trips', t => {
  const workspace = new Blockly.Workspace();
  t.after(() => workspace.dispose());
  const block = workspace.newBlock('compat_if');
  assert.equal(block.hasElse_, true);
  block.loadExtraState({ hasElse: false });
  assert.equal(block.getInput('ELSE'), null);
  assert.equal(block.saveExtraState().hasElse, false);
  const xml = block.mutationToDom();
  assert.equal(xml.getAttribute('else'), '0');
  const restored = workspace.newBlock('compat_if');
  restored.domToMutation(xml);
  assert.equal(restored.getInput('ELSE'), null);
  restored.loadExtraState({ hasElse: true, elseIfCount: 1 });
  assert.ok(restored.getInput('ELSE'));
  assert.ok(restored.getInput('IF1'));
  restored.loadExtraState({ hasElse: false });
  assert.equal(restored.getInput('ELSE'), null);
  assert.equal(restored.getInput('IF1'), null);
});

test('upstream switch compatibility restores default presence from both JSON and XML without leftover inputs', t => {
  const workspace = new Blockly.Workspace();
  t.after(() => workspace.dispose());
  const block = workspace.newBlock('compat_switch');
  assert.equal(block.hasDefault_, true);
  block.loadExtraState({ caseCount: 0, hasDefault: false });
  assert.equal(block.getInput('DEFAULT'), null);
  const xml = block.mutationToDom();
  const restored = workspace.newBlock('compat_switch');
  restored.domToMutation(xml);
  assert.equal(restored.getInput('DEFAULT'), null);
  assert.equal(restored.saveExtraState().hasDefault, false);
});

test('upstream dynamic inputs retain historical itemCount metadata without fabricating sockets', t => {
  const workspace = new Blockly.Workspace();
  t.after(() => workspace.dispose());
  const block = workspace.newBlock('compat_dynamic');
  block.loadExtraState({ itemCount: 4 });
  assert.equal(block.inputList.length, 1);
  assert.equal(block.saveExtraState().itemCount, 4);
  block.loadExtraState({ itemCount: 4, extraCount: 2 });
  assert.equal(block.inputList.length, 3);
  assert.equal(block.saveExtraState().extraCount, 2);
  block.loadExtraState({});
  assert.equal(block.inputList.length, 1);
  assert.equal(block.saveExtraState(), null);
});

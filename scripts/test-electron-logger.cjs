const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const { spawn } = require('node:child_process');
const os = require('node:os');
const { test } = require('node:test');

function loggerHarness() {
  const runtime = new EventEmitter();
  const messages = [];
  const logger = {
    transports: { file: { getFile: () => ({ path: 'app.log' }) }, console: {} },
  };
  let pipeError;
  let consoleFailures = 0;
  for (const level of ['info', 'warn', 'error']) {
    logger[level] = (...args) => {
      messages.push({ level, args });
      if (pipeError && logger.transports.console.level !== false && consoleFailures < 8) {
        consoleFailures += 1;
        runtime.emit('uncaughtException', pipeError);
      }
    };
  }
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', 'electron', 'logger.js'), 'utf8'), {
    module,
    process: runtime,
    console: {},
    require: name => {
      if (name === 'path') return path;
      if (name === 'fs') return { existsSync: () => true };
      if (name === 'electron-log') return logger;
      throw new Error(`Unexpected dependency: ${name}`);
    },
  });
  module.exports.initLogger('app-data');
  messages.length = 0;
  return {
    logger, runtime, messages,
    breakConsole(error) { pipeError = error; },
    get consoleFailures() { return consoleFailures; },
  };
}

test('a broken console pipe is recorded once without recursive exception logging', () => {
  const harness = loggerHarness();
  const error = Object.assign(new Error('broken pipe, write'), { code: 'EPIPE' });
  harness.breakConsole(error);
  harness.runtime.emit('uncaughtException', error);
  assert.equal(harness.logger.transports.console.level, false);
  assert.equal(harness.consoleFailures, 0);
  assert.equal(harness.messages.length, 1);
  assert.equal(harness.messages[0].level, 'error');
  assert.equal(harness.messages[0].args[1], error);
  assert.equal(harness.logger.transports.file.level, 'info');
  harness.logger.info('Project opened');
  harness.logger.error('A later application error');
  assert.equal(harness.messages.length, 3, 'file logging must remain active after console failure');
  assert.equal(harness.consoleFailures, 0);
});

test('other uncaught exceptions preserve console output and error details', () => {
  const harness = loggerHarness();
  const error = Object.assign(new Error('permission denied'), { code: 'EACCES' });
  harness.runtime.emit('uncaughtException', error);
  assert.equal(harness.logger.transports.console.level, 'info');
  assert.equal(harness.messages.length, 1);
  assert.equal(harness.messages[0].args[0], 'Uncaught Exception:');
  assert.equal(harness.messages[0].args[1], error);
});

test('unhandled promise rejections are still reported with their reason and promise', () => {
  const harness = loggerHarness();
  const reason = new Error('Project opening failed');
  const promise = Promise.resolve();
  harness.runtime.emit('unhandledRejection', reason, promise);
  assert.equal(harness.logger.transports.console.level, 'info');
  assert.equal(harness.messages.length, 1);
  assert.equal(harness.messages[0].level, 'error');
  assert.equal(harness.messages[0].args[1], promise);
  assert.equal(harness.messages[0].args[3], reason);
});

test('the real logger survives closed parent output pipes and continues writing its file', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'aily-logger-test-'));
  const filename = path.join(__dirname, '..', 'electron', 'logger.js');
  const child = spawn(process.execPath, ['-e', `
    const { Console } = require('node:console');
    global.console = new Console({ stdout: process.stdout, stderr: process.stderr, ignoreErrors: false });
    const logger = require(${JSON.stringify(filename)});
    logger.initLogger(${JSON.stringify(directory)});
    process.on('message', () => {
      console.log('Write to a closed pipe');
      setTimeout(() => {
        console.log('File logging survives');
        process.send({ consoleDisabled: logger.log.transports.console.level === false });
        process.exit(0);
      }, 200);
    });
    process.send('ready');
  `], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  const closed = new Promise(resolve => child.once('close', resolve));
  let timeout;
  try {
    const result = await new Promise((resolve, reject) => {
      timeout = setTimeout(() => reject(new Error('Logger did not recover from closed output pipes')), 8000);
      child.once('error', reject);
      child.once('exit', code => { if (code !== 0) reject(new Error(`Logger child exited with code ${code}`)); });
      child.on('message', message => {
        if (message === 'ready') {
          child.stdout.destroy();
          child.stderr.destroy();
          child.send('write');
        } else {
          resolve(message);
        }
      });
    });
    await closed;
    assert.equal(result.consoleDisabled, true);
    assert.equal(child.exitCode, 0);
    const log = fs.readFileSync(path.join(directory, 'logs', 'app.log'), 'utf8');
    assert.equal((log.match(/Uncaught Exception:/g) || []).length, 1, 'a broken pipe must not create an error loop');
    assert.match(log, /EPIPE/);
    assert.match(log, /File logging survives/);
  } finally {
    clearTimeout(timeout);
    if (child.exitCode === null) child.kill();
    await closed;
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

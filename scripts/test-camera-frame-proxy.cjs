const assert = require('node:assert/strict');
const http = require('node:http');
const { EventEmitter, once } = require('node:events');
const { test } = require('node:test');
const { createCameraFrameProxy, registerCameraPreviewHandlers } = require('../electron/camera-preview.js');

async function fixture(t, contentType = 'multipart/x-mixed-replace; boundary=frame') {
  const state = { requests: 0, active: 0, maxActive: 0 };
  const server = http.createServer((req, res) => {
    state.requests++;
    state.active++;
    state.maxActive = Math.max(state.maxActive, state.active);
    req.on('close', () => state.active--);
    res.writeHead(200, { 'Content-Type': contentType });
    res.write('--frame\r\nContent-Type: image/jpeg\r\n\r\nframe-test\r\n');
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  state.address = `http://127.0.0.1:${server.address().port}`;
  return state;
}
function request(url, firstChunk = false) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, { agent: false }, res => {
      const chunks = [];
      res.on('data', chunk => {
        chunks.push(chunk);
        if (firstChunk) resolve({ req, res, body: Buffer.concat(chunks) });
      });
      res.on('end', () => resolve({ req, res, body: Buffer.concat(chunks) }));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.setTimeout(5000, () => req.destroy(new Error('Local proxy test request timed out')));
  });
}

test('proxy reads a single local stream, exposes freshness and serves only bundled vision assets with CORS', async t => {
  const device = await fixture(t);
  const proxy = await createCameraFrameProxy(device.address);
  t.after(() => proxy.stop());
  const video = await request(proxy.url, true);
  assert.equal(video.res.statusCode, 200);
  assert.equal(video.res.headers['access-control-allow-origin'], '*');
  assert.match(video.body.toString(), /frame-test/);
  assert.ok(proxy.status().lastDataAt > 0);
  const root = proxy.url.replace('/stream/', '/vision/');
  for (const [file, type] of [['gesture_recognizer.task', 'application/octet-stream'],
    ['vision_wasm_internal.js', 'text/javascript'], ['vision_wasm_internal.wasm', 'application/wasm'],
    ['vision_wasm_nosimd_internal.js', 'text/javascript'], ['vision_wasm_nosimd_internal.wasm', 'application/wasm']]) {
    const resource = await request(`${root}/${file}`);
    assert.equal(resource.res.statusCode, 200);
    assert.equal(resource.res.headers['content-type'], type);
    assert.ok(resource.body.length > 100000, file);
  }
  for (const file of ['LICENSE', '../package.json', 'gesture_recognizer.task?other']) {
    assert.equal((await request(`${root}/${file}`)).res.statusCode, 404);
  }
  assert.equal(device.requests, 1, 'model and WASM requests cannot reconnect the camera');
  assert.equal(device.maxActive, 1);
  const stopped = proxy.stop();
  assert.equal(proxy.stop(), stopped, 'concurrent stop calls wait for the same cleanup');
  await stopped;
  assert.equal(proxy.status().success, false);
  await assert.rejects(request(proxy.url));
});

test('non-MJPEG upstream responses report 502 rather than a success-shaped video', async t => {
  const device = await fixture(t, 'text/html');
  const proxy = await createCameraFrameProxy(device.address);
  t.after(() => proxy.stop());
  const response = await request(proxy.url);
  assert.equal(response.res.statusCode, 502);
  assert.match(response.body.toString(), /MJPEG/);
});

test('invalid camera addresses are rejected before opening a proxy listener', async () => {
  for (const address of ['', 'a b', 'ftp://camera/stream', 'file:///camera', 'http://user:pass@camera', 'http://camera/#part']) {
    await assert.rejects(createCameraFrameProxy(address));
  }
});

test('IPC isolates owners and removes navigation/crash listeners when a preview closes', async t => {
  const device = await fixture(t);
  const handlers = new Map();
  registerCameraPreviewHandlers({ handle: (name, callback) => handlers.set(name, callback) });
  const sender = new EventEmitter();
  sender.id = 41;
  sender.isDestroyed = () => false;
  const event = { sender };
  const opened = await handlers.get('camera-preview-start')(event, device.address);
  assert.equal(opened.success, true);
  t.after(() => handlers.get('camera-preview-stop')(event, opened.url));
  assert.equal(handlers.get('camera-preview-status')({ sender: { id: 42 } }, opened.url).success, false);
  await handlers.get('camera-preview-stop')({ sender: { id: 42 } }, opened.url);
  assert.equal(handlers.get('camera-preview-status')(event, opened.url).success, true);
  sender.emit('did-start-navigation', {}, 'local-test', false, true);
  assert.equal(handlers.get('camera-preview-status')(event, opened.url).success, false);
  assert.equal(sender.listenerCount('did-start-navigation'), 0);
  assert.equal(sender.listenerCount('destroyed'), 0);
  assert.equal(sender.listenerCount('render-process-gone'), 0);
});

test('stopping a proxy also closes idle model requests and partial asset transfers promptly', { timeout: 10000 }, async t => {
  const device = await fixture(t);
  const proxy = await createCameraFrameProxy(device.address);
  t.after(() => proxy.stop());
  const resource = await request(`${proxy.url.replace('/stream/', '/vision/')}/vision_wasm_internal.wasm`, true);
  resource.res.pause();
  const started = performance.now();
  try { await proxy.stop(); }
  finally { resource.req.destroy(); }
  assert.ok(performance.now() - started < 1000, 'proxy cleanup must finish within 1 second');
});

const http = require('node:http');
const https = require('node:https');
const { randomUUID } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

async function createCameraFrameProxy(address) {
  if (typeof address !== 'string' || !address.trim() || /\s/.test(address.trim())) throw new Error('Invalid camera address');
  const target = new URL(/^[a-z][a-z\d+.-]*:\/\//i.test(address.trim()) ? address.trim() : `http://${address.trim()}`);
  if (!['http:', 'https:'].includes(target.protocol) || target.username || target.password || target.hash) {
    throw new Error('Invalid camera address');
  }
  if (target.pathname === '/') target.pathname = '/stream';
  const route = `/stream/${randomUUID()}`;
  const assetsRoute = route.replace('/stream/', '/vision/') + '/';
  const devAssets = path.join(__dirname, '..', 'public', 'vision', 'gesture');
  const assets = fs.existsSync(devAssets) ? devAssets : path.join(__dirname, '..', 'renderer', 'vision', 'gesture');
  let upstream, client, stopPromise, lastDataAt = 0, stopped = false;
  const sockets = new Set();
  const server = http.createServer((req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Cache-Control', 'no-store');
    if (req.method === 'GET' && req.url.startsWith(assetsRoute) && !stopped) {
      const name = req.url.slice(assetsRoute.length);
      if (!['gesture_recognizer.task', 'vision_wasm_internal.js', 'vision_wasm_internal.wasm',
        'vision_wasm_nosimd_internal.js', 'vision_wasm_nosimd_internal.wasm'].includes(name)) {
        res.writeHead(404); res.end(); return;
      }
      const file = path.join(assets, name);
      if (!fs.existsSync(file)) { res.writeHead(404); res.end('Vision runtime asset is missing'); return; }
      res.setHeader('Content-Type', name.endsWith('.wasm') ? 'application/wasm'
        : name.endsWith('.js') ? 'text/javascript' : 'application/octet-stream');
      const stream = fs.createReadStream(file);
      stream.on('error', error => { console.warn('Vision asset failed:', error.message); res.destroy(); });
      res.on('close', () => stream.destroy());
      stream.pipe(res);
      return;
    }
    if (req.method !== 'GET' || req.url !== route || stopped) { res.writeHead(404); res.end(); return; }
    upstream?.destroy();
    client?.destroy();
    client = res;
    lastDataAt = 0;
    const request = (target.protocol === 'https:' ? https : http).get(target, response => {
      if (response.statusCode !== 200 || !/^multipart\/x-mixed-replace/i.test(response.headers['content-type'] || '')) {
        response.destroy();
        res.writeHead(502); res.end('Camera did not return an MJPEG stream');
        return;
      }
      res.writeHead(200, { 'Content-Type': response.headers['content-type'] });
      response.on('data', () => { lastDataAt = Date.now(); });
      response.on('error', error => { console.warn('Camera stream failed:', error.message); res.destroy(); });
      response.pipe(res);
    });
    upstream = request;
    request.setTimeout(5000, () => request.destroy(new Error('Camera stream timed out')));
    request.on('error', error => {
      console.warn('Camera preview failed:', error.message);
      if (!res.headersSent) { res.writeHead(502); res.end('Camera stream failed'); }
      else res.destroy();
    });
    res.on('close', () => request.destroy());
  });
  server.on('connection', socket => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const port = server.address().port;
  return {
    url: `http://127.0.0.1:${port}${route}`,
    status: () => ({ success: !stopped, lastDataAt }),
    stop: () => {
      if (stopPromise) return stopPromise;
      stopped = true; upstream?.destroy(); client?.destroy();
      stopPromise = new Promise(resolve => {
        server.close(resolve);
        for (const socket of sockets) socket.destroy();
      });
      return stopPromise;
    },
  };
}

function registerCameraPreviewHandlers(ipcMain) {
  const owners = new Map();
  const fail = error => {
    console.warn('Camera preview control failed:', error.message);
    return { success: false, message: error.message };
  };
  ipcMain.handle('camera-preview-start', async (event, address) => {
    const previous = owners.get(event.sender.id);
    const current = { proxy: null };
    owners.set(event.sender.id, current);
    const cleanup = async () => {
      if (owners.get(event.sender.id) === current) owners.delete(event.sender.id);
      await current.proxy?.stop();
    };
    const onDestroyed = () => { void current.cleanup().catch(error => fail(error)); };
    const onNavigation = (_event, _url, inPlace, isMainFrame) => { if (isMainFrame && !inPlace) onDestroyed(); };
    current.cleanup = async () => {
      event.sender.removeListener('destroyed', onDestroyed);
      event.sender.removeListener('render-process-gone', onDestroyed);
      event.sender.removeListener('did-start-navigation', onNavigation);
      await cleanup();
    };
    event.sender.once('destroyed', onDestroyed);
    event.sender.once('render-process-gone', onDestroyed);
    event.sender.on('did-start-navigation', onNavigation);
    try {
      if (previous?.cleanup) await previous.cleanup();
      else await previous?.proxy?.stop();
      current.proxy = await createCameraFrameProxy(address);
      if (event.sender.isDestroyed() || owners.get(event.sender.id) !== current) {
        await current.proxy.stop();
        throw new Error('Camera preview was closed during startup');
      }
      return { success: true, url: current.proxy.url };
    } catch (error) { await current.cleanup(); return fail(error); }
  });
  ipcMain.handle('camera-preview-stop', async (event, url) => {
    const current = owners.get(event.sender.id);
    if (!current || current.proxy?.url !== url) return { success: true };
    try { await current.cleanup(); return { success: true }; }
    catch (error) { return fail(error); }
  });
  ipcMain.handle('camera-preview-status', (event, url) => {
    const current = owners.get(event.sender.id);
    return current?.proxy?.url === url ? current.proxy.status() : { success: false, message: 'Camera preview is closed' };
  });
}

module.exports = { createCameraFrameProxy, registerCameraPreviewHandlers };

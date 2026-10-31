const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test, afterEach } = require('node:test');
const ts = require('typescript');
const { BehaviorSubject, Subject } = require('rxjs');
const services = path.resolve(__dirname, '..', 'src', 'app', 'services');
const load = require('./helpers/load-crazyflie-data.cjs');
const protocol = load(path.join(services, 'camera-gesture.ts'));
const cameraProtocol = load(path.join(services, 'ai-deck-camera.ts'));
const binding = (extra = {}) => ({
  gesture: 'Open_Palm', holdSeconds: 0.5, code: 'cf_print("user-defined action")', blockIds: ['action'], ...extra,
});
const on = value => `cf_camera_gesture_on(${JSON.stringify(value)})`;

function openHand() {
  return [
    [.5, .85], [.37, .75], [.31, .69], [.26, .6], [.22, .5],
    [.43, .6], [.43, .4], [.43, .3], [.43, .2],
    [.5, .58], [.5, .37], [.5, .25], [.5, .15],
    [.57, .6], [.57, .4], [.57, .3], [.57, .21],
    [.64, .65], [.64, .5], [.64, .4], [.64, .33],
  ].map(([x, y]) => ({ x: .5 + (x - .5) * .5, y: .5 + (y - .5) * .5, z: 0 }));
}
const handFrame = (hand, name = 'None', score = 0) => ({
  gestures: [[{ categoryName: name, score }]], landmarks: [hand],
});
const translateHand = (hand, dx, dy) => hand.map(point => ({ ...point, x: point.x + dx, y: point.y + dy }));
function foldedFinger(hand, mcp) {
  const { x, y } = hand[mcp];
  hand[mcp + 1] = { x: x + .01, y: y - .05, z: 0 };
  hand[mcp + 2] = { x: x + .02, y: y - .01, z: 0 };
  hand[mcp + 3] = { x, y: y - .015, z: 0 };
}

test('OK uses fingertip contact and three extended fingers; pointing supports rotated hands', () => {
  const ok = openHand();
  foldedFinger(ok, 5);
  ok[8] = { x: .45, y: .51, z: 0 };
  ok[4] = { x: .455, y: .51, z: 0 };
  assert.equal(protocol.recognizeCameraStaticGesture(handFrame(ok)), 'OK');
  const separated = ok.map(point => ({ ...point }));
  separated[4].x -= .08;
  assert.equal(protocol.recognizeCameraStaticGesture(handFrame(separated)), null);
  const curled = ok.map(point => ({ ...point }));
  foldedFinger(curled, 13);
  assert.equal(protocol.recognizeCameraStaticGesture(handFrame(curled)), null);
  const pointing = openHand();
  for (const mcp of [9, 13, 17]) foldedFinger(pointing, mcp);
  pointing[4] = { ...pointing[5], y: pointing[5].y + .025 };
  for (const angle of [0, Math.PI / 2, Math.PI]) {
    const rotated = pointing.map(point => ({ ...point,
      x: .5 + (point.x - .5) * Math.cos(angle) - (point.y - .5) * Math.sin(angle),
      y: .5 + (point.x - .5) * Math.sin(angle) + (point.y - .5) * Math.cos(angle),
    }));
    assert.equal(protocol.recognizeCameraStaticGesture(handFrame(rotated)), 'Pointing_Up');
  }
});

test('the original seven model gestures remain available; missing, clipped, corrupt and multiple hands cannot use geometry', () => {
  for (const gesture of protocol.CAMERA_GESTURES.filter(value => !protocol.isCameraSwipe(value) && value !== 'OK')) {
    assert.equal(protocol.recognizeCameraStaticGesture(handFrame(openHand(), gesture, .85)), gesture);
  }
  const hand = openHand();
  for (const invalid of [hand.slice(1), hand.map((point, index) => index ? point : { ...point, x: NaN }),
    translateHand(hand, 1, 0)]) {
    assert.equal(protocol.recognizeCameraStaticGesture(handFrame(invalid, 'Open_Palm', 1)), null);
  }
  assert.equal(protocol.recognizeCameraStaticGesture({ ...handFrame(hand, 'Open_Palm', 1), landmarks: [hand, hand] }), null);
  for (const gesture of ['OK', 'Swipe_Left']) {
    assert.equal(protocol.recognizeCameraStaticGesture({ gestures: [[{ categoryName: gesture, score: 1 }]] }), null);
  }
});

test('all four palm swipes require preparation, full displacement and two consistent frames, then latch until release', () => {
  for (const [gesture, dx, dy] of [
    ['Swipe_Left', -.18, 0], ['Swipe_Right', .18, 0], ['Swipe_Up', 0, -.18], ['Swipe_Down', 0, .18],
  ]) {
    const tracker = new protocol.CameraPalmSwipe();
    const hand = openHand(), moved = translateHand(hand, dx, dy);
    for (const now of [0, 250, 500]) assert.equal(tracker.update('Open_Palm', hand, now, () => 500), null);
    assert.equal(tracker.update('Open_Palm', moved, 750, () => 500), null);
    assert.deepEqual(JSON.parse(JSON.stringify(tracker.update('Open_Palm', moved, 1000, () => 500))),
      { gesture, heldSeconds: .5 });
    for (const now of [1250, 1500, 3000, 3250]) assert.equal(tracker.update('Open_Palm', moved, now, () => 500), null);
    for (const now of [3500, 3750, 4000]) tracker.update(null, undefined, now, () => 500);
    for (const now of [4250, 4500, 4750]) tracker.update('Open_Palm', hand, now, () => 500);
    tracker.update('Open_Palm', moved, 5000, () => 500);
    assert.equal(tracker.update('Open_Palm', moved, 5250, () => 500)?.gesture, gesture);
  }
});

test('short preparation, jitter, diagonal movement, depth scaling and a single jump never emit a swipe', () => {
  const hand = openHand();
  for (const [dx, dy, hold] of [[.18, 0, 501], [.02, 0, 500], [.18, .18, 500]]) {
    const tracker = new protocol.CameraPalmSwipe();
    for (const now of [0, 250, 500]) tracker.update('Open_Palm', hand, now, () => hold);
    for (const now of [750, 1000, 1250, 1500]) {
      assert.equal(tracker.update('Open_Palm', translateHand(hand, dx, dy), now, () => hold), null);
    }
  }
  const tracker = new protocol.CameraPalmSwipe();
  for (const now of [0, 250, 500]) tracker.update('Open_Palm', hand, now, () => 500);
  tracker.update('Open_Palm', translateHand(hand, .18, 0), 750, () => 500);
  assert.equal(tracker.update('Open_Palm', hand, 1000, () => 500), null);
  const scaled = hand.map(point => ({ ...point, x: .5 + (point.x - .5) * 1.5, y: .5 + (point.y - .5) * 1.5 }));
  assert.equal(tracker.update('Open_Palm', scaled, 1250, () => 500), null);
});
test('every supported UI language contains complete, non-empty gesture labels and error messages', () => {
  const directory = path.resolve(__dirname, '..', 'public', 'i18n');
  const english = JSON.parse(fs.readFileSync(path.join(directory, 'en', 'en.json'), 'utf8')).CAMERA_GESTURE;
  for (const language of ['ar', 'de', 'en', 'es', 'fr', 'ja', 'ko', 'pt', 'ru', 'zh_cn', 'zh_hk']) {
    const labels = JSON.parse(fs.readFileSync(path.join(directory, language, `${language}.json`), 'utf8')).CAMERA_GESTURE;
    assert.deepEqual(Object.keys(labels).sort(), Object.keys(english).sort(), language);
    for (const value of Object.values(labels)) assert.ok(typeof value === 'string' && value.trim(), language);
  }
});

const fixtures = [];
function harness(policy = 'sim-only') {
  const h = { now: 0, timers: new Map(), events: [], runs: [], notices: [], closes: 0,
    fresh: true, result: { gestures: [] }, modelFactory: null };
  const exports = {};
  const model = { recognizeForVideo: () => h.result, close: () => h.closes++ };
  const camera = {
    gestureState$: new BehaviorSubject({ phase: 'idle', authorized: false, realMode: false, gesture: null, error: '' }),
    gesture$: new Subject(), command$: new BehaviorSubject(null),
    execute: command => { camera.command$.next(command); },
    frameSource: { prepareForRecognition: async () => ({}), frameIsFresh: async () => h.fresh,
      recognitionAssetRoot: () => 'http://127.0.0.1/vision/local-test' },
  };
  vm.runInNewContext(ts.transpileModule(fs.readFileSync(path.join(services, 'camera-gesture.service.ts'), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022,
      experimentalDecorators: true, esModuleInterop: true },
  }).outputText, {
    exports, performance: { now: () => h.now },
    document: { hidden: false, addEventListener() {}, removeEventListener() {} },
    console: { warn() {}, info() {} },
    setTimeout: callback => { const id = Symbol(); h.timers.set(id, callback); return id; },
    clearTimeout: id => h.timers.delete(id),
    require: name => {
      if (name === '@angular/core') return { Injectable: () => value => value };
      if (name === 'rxjs') return require(name);
      if (name === './camera-gesture') return protocol;
      if (name === './ai-deck-camera') return cameraProtocol;
      if (name === '@mediapipe/tasks-vision') return {
        FilesetResolver: { forVisionTasks: async () => ({}) },
        GestureRecognizer: { createFromOptions: () => h.modelFactory ? h.modelFactory(model) : Promise.resolve(model) },
      };
      return {};
    },
  });
  h.camera = camera;
  h.runtime = { policy$: new BehaviorSubject(policy) };
  h.connection = {
    state$: new BehaviorSubject({ status: 'ready', busy: false, uri: 'local-test', radioSerial: 'test' }),
    flightReadiness$: new BehaviorSubject({ status: 'ready' }),
  };
  h.service = new exports.CameraGestureService(camera, h.runtime, h.connection,
    { update: message => h.notices.push(message) }, { instant: key => key });
  h.executor = {
    run: async (value, mode) => { h.runs.push({ value, mode }); },
    cancel: async () => {},
    interrupt: async () => false,
  };
  h.service.setExecutor(h.executor);
  camera.gesture$.subscribe(value => h.events.push(value));
  h.hand = (gesture = 'Open_Palm', score = 0.85, count = 1) => {
    h.result = { gestures: Array.from({ length: count }, () => [{ categoryName: gesture, score }]),
      landmarks: Array.from({ length: count }, () => openHand()) };
  };
  h.advance = async ms => {
    for (let i = 0; i < 6; i++) await Promise.resolve();
    h.now += ms;
    const entry = h.timers.entries().next().value;
    if (entry) { h.timers.delete(entry[0]); await entry[1](); }
    await Promise.resolve();
  };
  fixtures.push(h);
  return h;
}
afterEach(async () => {
  for (const h of fixtures.splice(0)) {
    await h.service.stop();
    h.service.ngOnDestroy();
    assert.equal(h.timers.size, 0);
  }
});

test('a recognized swipe emits only its configured event; an empty event never runs a hardware action', async () => {
  const h = harness();
  await h.service.runProgram(on(binding({ gesture: 'Swipe_Left', code: '' })), () => {});
  const hand = openHand();
  h.result = handFrame(hand, 'Open_Palm', .95);
  await h.service.start();
  for (let i = 0; i < 3; i++) await h.advance(250);
  h.result = handFrame(translateHand(hand, -.18, 0), 'Open_Palm', .95);
  await h.advance(250);
  await h.advance(250);
  assert.equal(h.events.filter(event => event.gesture === 'Swipe_Left').length, 1);
  assert.equal(h.runs.length, 0);
  await h.service.stop();
  assert.equal(h.camera.gestureState$.value.gesture, null);
});

test('stable gestures meet the exact hold threshold and require 500ms release before retriggering', () => {
  const tracker = new protocol.StableCameraGesture();
  for (const time of [0, 250, 500, 750, 1000, 1199]) assert.equal(tracker.update('Open_Palm', time, 1200), null);
  assert.equal(tracker.update('Open_Palm', 1200, 1200), 'Open_Palm');
  assert.equal(tracker.heldSeconds(1200), 1.2);
  assert.equal(tracker.update(null, 1450, 1200), null);
  assert.equal(tracker.update('Open_Palm', 1700, 1200), null);
  for (let time = 1950; time <= 2950; time += 250) assert.equal(tracker.update('Open_Palm', time, 1200), null);
  for (const time of [3200, 3450, 3700]) tracker.update(null, time, 500);
  assert.equal(tracker.update('Open_Palm', 3950, 500), null);
  tracker.update('Open_Palm', 4200, 500);
  assert.equal(tracker.update('Open_Palm', 4450, 500), 'Open_Palm');
});

test('a dropped frame or one noisy category never re-arms a confirmed gesture; another stable gesture can fire', () => {
  const tracker = new protocol.StableCameraGesture();
  tracker.update('Open_Palm', 0, 500);
  tracker.update('Open_Palm', 250, 500);
  assert.equal(tracker.update('Open_Palm', 500, 500), 'Open_Palm');
  tracker.update('Closed_Fist', 750, 500);
  for (const time of [1000, 1250, 1500]) assert.equal(tracker.update('Open_Palm', time, 500), null);
  for (const time of [3000, 3250, 3500]) assert.equal(tracker.update('Open_Palm', time, 500), null);
  tracker.update('Closed_Fist', 3750, 500);
  tracker.update('Closed_Fist', 4000, 500);
  assert.equal(tracker.update('Closed_Fist', 4250, 500), 'Closed_Fist');
});

test('gesture payloads and complete startup commands reject malformed input before execution', () => {
  assert.equal(protocol.parseCameraGestureCall(on(binding())).binding.gesture, 'Open_Palm');
  assert.equal(protocol.isCameraGestureProgram('cf_print("cf_camera_gesture_start()")'), false);
  assert.doesNotThrow(() => protocol.parseCameraGestureCall(on(binding({ code: 'cf_print("cf_camera_gesture_start()")' }))));
  for (const extra of [{ gesture: 'unknown' }, { holdSeconds: 0.4999 }, { holdSeconds: 5.001 },
    { holdSeconds: '1' }, { code: 'cf_camera_gesture_stop()' }, { blockIds: [42] }]) {
    assert.throws(() => protocol.parseCameraGestureCall(on(binding(extra))), /INVALID_PROGRAM/);
  }
  assert.throws(() => protocol.validateCameraGestureProgram(`${on(binding())}\n${on(binding())}`), /DUPLICATE_EVENT/);
  for (const command of ['cf_delay(foo)', 'cf_delay(3601)', 'cf_takeoff(0.3)', 'cf_print("ok"); cf_land()']) {
    assert.throws(() => protocol.validateCameraGestureProgram(`${on(binding())}\n${command}`));
  }
});

test('recognition filters unknown, low-confidence and multi-hand frames and dispatches only user-defined code', async () => {
  const h = harness();
  await h.service.runProgram(on(binding()), () => {});
  await h.service.start();
  for (const [name, score, count] of [['Open_Palm', 0.849, 1], ['Open_Palm', 1, 2], ['None', 1, 1]]) {
    h.hand(name, score, count);
    for (let i = 0; i < 4; i++) await h.advance(250);
  }
  assert.equal(h.events.length, 0);
  assert.equal(h.runs.length, 0);
  h.hand();
  for (let i = 0; i < 5; i++) await h.advance(250);
  assert.equal(h.events.length, 1);
  assert.equal(h.events[0].heldSeconds, 0.5);
  assert.equal(h.runs.length, 1);
  assert.equal(h.runs[0].value.code, 'cf_print("user-defined action")');
  assert.equal(h.runs[0].mode, 'sim-only');
});

test('unbound and empty gestures emit metadata without attempting an action', async () => {
  const h = harness('real-only');
  h.service.setExecutor(null);
  await h.service.runProgram(on(binding({ code: '', blockIds: [] })), () => {});
  h.hand();
  await h.service.start();
  for (let i = 0; i < 7; i++) await h.advance(250);
  assert.equal(h.events.length, 1);
  assert.ok(h.events[0].heldSeconds >= 1.2);
  assert.equal(h.notices.length, 0);
  assert.equal(h.runs.length, 0);
});

test('real actions require manual authorization, use at least 1.2s hold and revoke permission on link changes', async () => {
  const h = harness('real-only');
  await h.service.runProgram(on(binding()), () => {});
  h.hand();
  await h.service.start();
  for (let i = 0; i < 6; i++) await h.advance(250);
  assert.equal(h.runs.length, 0);
  assert.match(h.notices.at(-1).text, /AUTHORIZATION_REQUIRED/);
  h.service.authorize(true);
  h.result = { gestures: [] };
  for (let i = 0; i < 3; i++) await h.advance(250);
  h.hand();
  for (let i = 0; i < 5; i++) await h.advance(250);
  assert.equal(h.runs.length, 0);
  await h.advance(250);
  assert.equal(h.runs.length, 1);
  assert.equal(h.service.realAllowed('real-only'), true);
  h.connection.state$.next({ ...h.connection.state$.value, uri: 'changed-link' });
  assert.equal(h.service.realAllowed('real-only'), false);
  await h.service.stop();
  h.service.authorize(true);
  assert.equal(h.camera.gestureState$.value.authorized, true);
  h.camera.command$.next({ type: 'close' });
  assert.equal(h.camera.gestureState$.value.authorized, false, 'closing also revokes authorization when recognition was already stopped');
});

test('closing or changing mode during model loading closes the late model without restarting inference', async () => {
  for (const change of ['close', 'mode']) {
    const h = harness();
    let resolve;
    h.modelFactory = model => new Promise(done => { resolve = () => done(model); });
    const start = h.service.start();
    for (let i = 0; !resolve && i < 20; i++) await Promise.resolve();
    assert.equal(typeof resolve, 'function');
    if (change === 'close') h.camera.command$.next({ type: 'close' });
    else h.runtime.policy$.next('real-only');
    resolve();
    await start;
    assert.equal(h.closes, 1);
    assert.equal(h.camera.gestureState$.value.phase, 'idle');
    assert.equal(h.timers.size, 0);
  }
});

test('stale video cancels only the active gesture action and closes the model', async () => {
  const h = harness();
  let finish, cancelled = 0;
  h.executor.run = async () => { await new Promise(resolve => { finish = resolve; }); };
  h.executor.cancel = async mode => { assert.equal(mode, 'sim-only'); cancelled++; finish(); };
  await h.service.runProgram(on(binding()), () => {});
  h.hand();
  await h.service.start();
  await h.advance(250);
  await h.advance(250);
  assert.equal(typeof finish, 'function');
  h.fresh = false;
  await h.advance(250);
  assert.equal(cancelled, 1);
  assert.equal(h.closes, 1);
  assert.equal(h.camera.gestureState$.value.phase, 'idle');
  assert.match(h.notices.at(-1).text, /STALE_VIDEO/);
});

test('malformed startup commands do not partially open cameras or register an executable program', async () => {
  const h = harness();
  await assert.rejects(h.service.runProgram(`${on(binding())}\ncf_delay(foo)`, () => {}));
  assert.equal(h.service.programRunning, false);
  assert.equal(h.camera.command$.value, null);
  assert.equal(h.closes, 0);
  assert.equal(h.runs.length, 0);
});

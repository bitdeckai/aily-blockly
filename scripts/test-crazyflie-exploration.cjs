const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');
const ts = require('typescript');
const THREE = require('three');

const root = path.resolve(__dirname, '..');
const services = path.join(root, 'src', 'app', 'services');
const cache = new Map();
const drawing = { beginPath() {}, roundRect() {}, fill() {}, stroke() {}, fillText() {} };
function load(filename) {
  if (cache.has(filename)) return cache.get(filename);
  const exports = {};
  cache.set(filename, exports);
  const js = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, experimentalDecorators: true },
  }).outputText;
  vm.runInNewContext(js, {
    exports, console,
    document: { createElement: () => ({ getContext: () => drawing }) },
    setTimeout: fn => { queueMicrotask(fn); return 1; }, clearTimeout() {},
    require: name => {
      if (name === '@angular/core') return { Injectable: () => type => type };
      if (name.startsWith('.')) return load(path.resolve(path.dirname(filename), `${name}.ts`));
      return require(name);
    },
  });
  return exports;
}
const exploration = load(path.join(services, 'crazyflie-exploration.ts'));
const { EXPLORATION_SCENES, ExplorationTracker, explorationPointPosition, EXPLORATION_RADIUS_M } = exploration;
const models = load(path.join(services, 'crazyflie-exploration-scene.ts'));
const homes = load(path.join(services, 'crazyflie-home-scene.ts'));
const { CrazyflieSimService } = load(path.join(services, 'crazyflie-sim.service.ts'));
const plain = value => JSON.parse(JSON.stringify(value));
const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-6, `${a} != ${b}`);
const simulator = () => new CrazyflieSimService({ setDeckDetected() {} });
const getTranslation = (values, key) => key.split('.').reduce((value, part) => value?.[part], values);

test('target guidance inverts the real simulator body transform at any heading and does not mutate the pose', () => {
  const sim = simulator();
  for (const degrees of [0, 45, 90, -90, 180, 179, -181, 540]) {
    for (const point of EXPLORATION_SCENES[0].points) {
      const pose = { x: 0.35, y: 0.46, z: -0.6, yaw: degrees * Math.PI / 180 };
      const original = { ...pose };
      const guide = exploration.explorationGuidance(pose, point);
      assert.deepEqual(pose, original);
      near(Math.hypot(guide.forward, guide.left, guide.up), guide.distance);
      sim.translateBody(pose, guide.forward, guide.left, guide.up);
      const target = explorationPointPosition(point);
      near(pose.x, target.x);
      near(pose.y, target.y);
      near(pose.z, target.z);
    }
  }
  const first = exploration.explorationGuidance({ x: 0, y: 0.06, z: 0, yaw: 0 }, EXPLORATION_SCENES[0].points[0]);
  near(first.forward, 1.2);
  near(first.left, -1.2);
  near(first.up, 0.6);
});

test('guidance and scoring share the exact three-dimensional boundary and reject invalid coordinates', () => {
  const point = EXPLORATION_SCENES[0].points[0];
  const target = explorationPointPosition(point);
  for (const offset of [0, 0.2499, 0.25, 0.2501]) {
    const pose = { ...target, x: target.x + offset, yaw: 0 };
    const guidance = exploration.explorationGuidance(pose, point);
    const tracker = new ExplorationTracker([point]);
    tracker.update(pose, 0, true);
    const progress = tracker.update(pose, 1000, true);
    assert.equal(guidance.inside, progress.visited.includes(point.id), `offset ${offset}`);
    assert.equal(guidance.inside, offset <= 0.25);
  }
  assert.equal(exploration.explorationGuidance({ ...target, x: target.x + 0.2, y: target.y + 0.2, yaw: 0 }, point).inside, false);
  for (const invalid of [{ yaw: NaN }, { x: Infinity }, { y: undefined }, { z: '1' }]) {
    assert.throws(() => exploration.explorationGuidance({ ...target, yaw: 0, ...invalid }, point), /finite simulation pose/);
  }
});

test('five themed scenes each provide five distinct reachable targets in the existing flight frame', () => {
  assert.deepEqual(plain(EXPLORATION_SCENES.map(scene => scene.id)), ['animals', 'botanical', 'science', 'space', 'ocean']);
  for (const scene of EXPLORATION_SCENES) {
    assert.equal(scene.points.length, 5);
    assert.equal(new Set(scene.stations).size, 5);
    assert.equal(new Set(scene.points.map(point => point.id)).size, 5);
    for (const point of scene.points) {
      const position = explorationPointPosition(point);
      near(position.x, -point.forward);
      near(position.z, point.left);
      near(position.y - 0.06, point.height);
      assert.ok(point.height >= 0.5 && point.height <= 1.2);
      assert.ok(Math.abs(position.x) + EXPLORATION_RADIUS_M < scene.size.width / 2);
      assert.ok(Math.abs(position.z) + EXPLORATION_RADIUS_M < scene.size.depth / 2);
      for (const other of scene.points.filter(other => other !== point)) {
        const second = explorationPointPosition(other);
        assert.ok(Math.hypot(position.x - second.x, position.y - second.y, position.z - second.z) > EXPLORATION_RADIUS_M * 2);
      }
    }
  }
  assert.equal(exploration.getExplorationScene('classroom'), undefined);
  assert.equal(exploration.getExplorationScene('home'), undefined);
  for (const invalid of ['custom', '', 'unknown']) assert.equal(exploration.isSelectableRoomPreset(invalid), false);
});

test('checkpoints require a full second inside the three-dimensional radius and permit any order', () => {
  const points = EXPLORATION_SCENES[0].points;
  const tracker = new ExplorationTracker(points);
  let now = 0;
  for (const index of [4, 1, 3, 0, 2]) {
    const target = explorationPointPosition(points[index]);
    let progress = tracker.update(target, now, true);
    assert.equal(progress.dwelling, index + 1);
    assert.ok(!progress.visited.includes(index + 1));
    progress = tracker.update(target, now + 999, true);
    assert.ok(!progress.visited.includes(index + 1), '999 ms must not count as one second');
    assert.equal(progress.dwellPercent, 99);
    progress = tracker.update(target, now + 1000, true);
    assert.ok(progress.visited.includes(index + 1));
    assert.equal(progress.dwelling, null);
    assert.equal(tracker.update(target, now + 1100, true).visited.length, progress.visited.length);
    now += 2000;
  }
  assert.deepEqual(plain(tracker.update({ x: 0, y: 0, z: 0 }, now, true).visited), [5, 2, 4, 1, 3]);
});

test('wrong height, exit/reentry, pause, real mode, invalid values and reversed time cannot earn a checkpoint', () => {
  const point = EXPLORATION_SCENES[0].points[0];
  const target = explorationPointPosition(point);
  for (const interruption of [
    { position: { ...target, y: target.y + 0.251 }, active: true, time: 600 },
    { position: { ...target, x: target.x + 0.251 }, active: true, time: 600 },
    { position: target, active: false, time: 600 },
    { position: { ...target, z: NaN }, active: true, time: 600 },
    { position: target, active: true, time: -1 },
  ]) {
    const tracker = new ExplorationTracker([point]);
    tracker.update(target, 0, true);
    assert.equal(tracker.update(target, 500, true).dwellPercent, 50);
    tracker.update(interruption.position, interruption.time, interruption.active);
    assert.equal(tracker.update(target, 1000, true).visited.length, 0);
    assert.equal(tracker.update(target, 1999, true).visited.length, 0);
    assert.equal(tracker.update(target, 2000, true).visited.length, 1);
  }
  const tracker = new ExplorationTracker([point]);
  tracker.update({ ...target, x: target.x + 0.25 }, 0, true);
  assert.equal(tracker.update({ ...target, x: target.x + 0.25 }, 1000, true).visited.length, 1,
    'the exact 25 cm boundary is included');
});

test('all scenes build unique exhibits and correctly positioned rings, use bounded geometry and release every owned resource once', () => {
  for (const scene of EXPLORATION_SCENES) {
    const group = models.createExplorationScene(scene, key => key.split('.').at(-1));
    assert.equal(group.name, `Exploration ${scene.id}`);
    const exhibits = group.children.filter(child => child.userData.exhibitId);
    assert.equal(exhibits.length, 5);
    for (const point of scene.points) {
      const checkpoint = group.getObjectByName(`Checkpoint ${point.id}`);
      const position = explorationPointPosition(point);
      near(checkpoint.position.x, position.x);
      near(checkpoint.position.y, position.y);
      near(checkpoint.position.z, position.z);
      near(checkpoint.getObjectByName('Checkpoint halo').geometry.parameters.radius, 0.25);
      for (const exhibit of exhibits) {
        const bounds = new THREE.Box3().setFromObject(exhibit);
        assert.ok(!bounds.containsPoint(new THREE.Vector3(position.x, position.y, position.z)), 'targets must not be inside exhibits');
      }
    }
    const bounds = new THREE.Box3().setFromObject(group);
    assert.ok([bounds.min.x, bounds.min.y, bounds.min.z, bounds.max.x, bounds.max.y, bounds.max.z].every(Number.isFinite));
    assert.ok(bounds.min.x >= -scene.size.width / 2 - 0.15 && bounds.max.x <= scene.size.width / 2 + 0.15, `${scene.id}: X ${bounds.min.x}..${bounds.max.x}`);
    assert.ok(bounds.min.z >= -scene.size.depth / 2 - 0.15 && bounds.max.z <= scene.size.depth / 2 + 0.15, `${scene.id}: Z ${bounds.min.z}..${bounds.max.z}`);
    assert.ok(bounds.min.y >= -0.21 && bounds.max.y < scene.size.height, `${scene.id}: H ${bounds.min.y}..${bounds.max.y}`);
    models.updateExplorationMarkers(group, { visited: [2], dwelling: 4, dwellPercent: 50 }, true);
    const material = id => group.getObjectByName(`Checkpoint ${id}`).getObjectByName('Checkpoint halo').material;
    assert.equal(material(2).color.getHexString(), '65b995');
    assert.equal(material(4).color.getHexString(), 'f5d992');
    assert.equal(material(1).color.getHexString(), 'e8b85d');
    models.updateExplorationMarkers(group, { visited: [], dwelling: null, dwellPercent: 0 }, false);
    for (const point of scene.points) assert.equal(group.getObjectByName(`Checkpoint ${point.id}`).visible, false);
    const owned = new Set();
    let vertices = 0, meshCount = 0;
    group.traverse(node => {
      if (node.isMesh || node.isLine) {
        owned.add(node.geometry);
        meshCount++;
        vertices += node.geometry.attributes.position.count;
      }
      if (node.material) {
        owned.add(node.material);
        if (node.material.map) owned.add(node.material.map);
      }
    });
    assert.ok(meshCount < 1200, `${scene.id}: ${meshCount} meshes`);
    assert.ok(vertices < 500000, `${scene.id}: ${vertices} vertices`);
    const disposals = new Map();
    owned.forEach(resource => resource.addEventListener('dispose', () => disposals.set(resource, (disposals.get(resource) ?? 0) + 1)));
    models.disposeExplorationScene(group);
    for (const resource of owned) assert.equal(disposals.get(resource), 1);
  }
});

test('selection rings keep completion colors and guide lines reuse their GPU buffers while tracking a target', () => {
  const scene = EXPLORATION_SCENES[0];
  const root = models.createExplorationScene(scene, key => key);
  try {
    const progress = { visited: [2], dwelling: 3, dwellPercent: 50 };
    models.updateExplorationMarkers(root, progress, true, 2);
    for (const point of scene.points) {
      assert.equal(root.getObjectByName(`Checkpoint ${point.id}`).getObjectByName('Checkpoint selection').visible, point.id === 2);
    }
    assert.equal(root.getObjectByName('Checkpoint 2').getObjectByName('Checkpoint halo').material.color.getHexString(), '65b995');
    const line = root.getObjectByName('Checkpoint guidance');
    const positions = line.geometry.getAttribute('position');
    const distances = line.geometry.getAttribute('lineDistance');
    const target = explorationPointPosition(scene.points[0]);
    for (let i = 0; i < 200; i++) {
      const pose = { x: i / 100, y: 0.5, z: -0.2 };
      models.updateExplorationGuide(root, pose, scene.points[0], true);
      assert.equal(line.visible, true);
      assert.equal(line.geometry.getAttribute('position'), positions);
      assert.equal(line.geometry.getAttribute('lineDistance'), distances);
      near(positions.getX(0), pose.x);
      near(positions.getY(1), target.y);
      near(positions.getZ(1), target.z);
      near(distances.getX(1), Math.hypot(target.x - pose.x, target.y - pose.y, target.z - pose.z));
    }
    models.updateExplorationGuide(root, { x: 0, y: 0, z: 0 }, undefined, true);
    assert.equal(line.visible, false);
    models.updateExplorationGuide(root, { x: 0, y: 0, z: 0 }, scene.points[0], false);
    assert.equal(line.visible, false);
    models.updateExplorationMarkers(root, progress, false, 2);
    assert.equal(root.getObjectByName('Checkpoint 2').visible, false);
    assert.equal(root.getObjectByName('Checkpoint 2').getObjectByName('Checkpoint selection').visible, false);
  } finally {
    models.disposeExplorationScene(root);
  }
});

function withinFloor(boundary, x, z) {
  let inside = false;
  for (let i = 0, j = boundary.length - 1; i < boundary.length; j = i++) {
    const [xi, zi] = boundary[i], [xj, zj] = boundary[j];
    if ((zi > z) !== (zj > z) && x < (xj - xi) * (z - zi) / (zj - zi) + xi) inside = !inside;
  }
  return inside;
}

test('museum floor plans have five distinct shapes, complete reachable target circles and richer collections', () => {
  const outlines = new Set();
  const coordinates = new Set();
  const overlaps = [];
  for (const scene of EXPLORATION_SCENES) {
    outlines.add(JSON.stringify(scene.boundary.map(([x, z]) => [x / scene.size.width, z / scene.size.depth])));
    coordinates.add(JSON.stringify(scene.points.map(point => [point.forward, point.left])));
    assert.ok(scene.reference.url.startsWith('https://'));
    assert.ok(withinFloor(scene.boundary, 0, 0), 'launch pad is inside the floor');
    const group = models.createExplorationScene(scene, key => key);
    try {
      assert.ok(group.getObjectByName(`Architecture ${scene.id}`));
      const collections = group.children.filter(child => child.userData.collection);
      assert.equal(collections.length, 10, 'two companion displays per principal collection');
      const displays = group.children.filter(child => child.userData.exhibitId || child.userData.collection);
      for (const point of scene.points) {
        const target = explorationPointPosition(point);
        for (let angle = 0; angle < Math.PI * 2; angle += Math.PI / 8) {
          assert.ok(withinFloor(scene.boundary, target.x + Math.cos(angle) * 0.25, target.z + Math.sin(angle) * 0.25),
            `${scene.id}: checkpoint ${point.id} overhangs its floor`);
        }
        for (const display of displays) {
          const bounds = new THREE.Box3().setFromObject(display).expandByScalar(0.25);
          if (bounds.containsPoint(new THREE.Vector3(target.x, target.y, target.z))) {
            overlaps.push(`${scene.id}: checkpoint ${point.id} overlaps ${display.name} at ${display.position.toArray()}`);
          }
        }
      }
    } finally {
      models.disposeExplorationScene(group);
    }
  }
  assert.equal(outlines.size, 5);
  assert.equal(coordinates.size, 5);
  assert.deepEqual(overlaps, []);
});

test('the garden apartment has three furnished bedrooms, kitchen, bathroom and an accessible sky garden', () => {
  const home = homes.createHomeScene(key => key);
  try {
    home.updateMatrixWorld(true);
    const rooms = home.children.filter(child => child.userData.room);
    assert.equal(rooms.length, 9);
    let beds = 0, windows = 0, vertices = 0;
    const doorways = [];
    home.traverse(node => {
      if (node.userData.bed) beds++;
      if (node.name === 'Floor-to-ceiling window') windows++;
      if (node.name === 'Open apartment doorway') doorways.push(node);
      if (node.isMesh) vertices += node.geometry.attributes.position.count;
    });
    assert.equal(beds, 3);
    assert.ok(windows >= 6);
    assert.equal(doorways.length, 7);
    for (const doorway of doorways) assert.ok(doorway.userData.clearWidth >= 1.1);
    for (const name of ['Kitchen sink', 'Kitchen extractor', 'Refrigerator', 'Toilet bowl', 'Shower tray', 'Sky garden lawn', 'Television']) {
      assert.ok(home.getObjectByName(name), name);
    }
    assert.ok(vertices < 150000, `${vertices} apartment vertices`);
    const launch = new THREE.Vector3(0, 0.15, 0);
    const terraceDoor = new THREE.Vector3(0, 0.7, 3.35);
    home.traverse(node => {
      if (!node.isMesh) return;
      const bounds = new THREE.Box3().setFromObject(node);
      assert.ok(!bounds.containsPoint(launch), `${node.name} blocks the launch pad`);
      assert.ok(!bounds.containsPoint(terraceDoor), `${node.name} blocks the open terrace doorway`);
    });
    const sim = simulator();
    sim.setRoomPreset('home');
    assert.deepEqual(plain(sim.roomSize$.value), plain(exploration.HOME_ROOM_SIZE));
    assert.deepEqual(plain(sim.pose$.value), { x: 0, y: 0.06, z: 0, yaw: 0 });
    assert.equal(sim.explorationProgress$.value.visited.length, 0);
    const owned = new Set(), disposed = new Map();
    home.traverse(node => {
      if (node.isMesh) owned.add(node.geometry);
      if (node.material) {
        owned.add(node.material);
        if (node.material.map) owned.add(node.material.map);
      }
    });
    owned.forEach(resource => resource.addEventListener('dispose', () => disposed.set(resource, (disposed.get(resource) || 0) + 1)));
    models.disposeExplorationScene(home);
    for (const resource of owned) assert.equal(disposed.get(resource), 1);
  } catch (error) {
    models.disposeExplorationScene(home);
    throw error;
  }
});

test('simulation awards checkpoints during waits even with the panel hidden, and resets on rerun, reset and scene change', async () => {
  const sim = simulator();
  sim.setRoomPreset('animals');
  assert.equal(sim.panelVisible$.value, false);
  assert.deepEqual(plain(sim.roomSize$.value), plain(EXPLORATION_SCENES[0].size));
  const visited = [];
  const sub = sim.explorationProgress$.subscribe(progress => visited.push([...progress.visited]));
  // Keep the command parser and scheduler real; only the clock is accelerated by the test timer.
  const result = await sim.runCode('cf_motion("takeoff", [0.6, 0.5])\ncf_motion("move", [1.2, -1.2, 0, 0.5])\ncf_delay(1.2)\ncf_motion("land", [0.5])');
  assert.equal(result.success, true, result.message);
  assert.deepEqual(plain(sim.explorationProgress$.value.visited), [1]);
  assert.ok(visited.some(ids => ids.includes(1)));
  assert.throws(() => {
    sim.running$.next(true);
    sim.resetExploration();
  }, /运行期间/);
  assert.throws(() => sim.resetPose(), /运行期间/);
  sim.running$.next(false);
  sim.resetExploration();
  assert.equal(sim.explorationProgress$.value.visited.length, 0);
  await sim.runCode('cf_print("new run")');
  assert.equal(sim.explorationProgress$.value.visited.length, 0);
  sim.setRoomPreset('ocean');
  assert.deepEqual(plain(sim.pose$.value), { x: 0, y: 0.06, z: 0, yaw: 0 });
  assert.equal(sim.explorationProgress$.value.visited.length, 0);
  sim.setRoomPreset('classroom');
  near(sim.pose$.value.y, 0.76573);
  sub.unsubscribe();
});

test('real-follow poses cannot earn simulation checkpoints and cancellation never continues dwelling', async () => {
  const sim = simulator();
  sim.setRoomPreset('space');
  sim.beginRealFollow();
  sim.pose$.next({ ...explorationPointPosition(EXPLORATION_SCENES[3].points[0]), yaw: 0 });
  await sim.sleep(2000);
  assert.equal(sim.explorationProgress$.value.visited.length, 0);
  assert.throws(() => sim.setRoomPreset('science'), /运行期间/);
  sim.endRealFollow('done');
  sim.resetPose();
  sim.running$.next(true);
  sim.pose$.next({ ...explorationPointPosition(EXPLORATION_SCENES[3].points[0]), yaw: 0 });
  await sim.sleep(600);
  sim.cancelRun();
  await sim.sleep(1000);
  assert.equal(sim.explorationProgress$.value.visited.length, 0);
  assert.equal(sim.explorationProgress$.value.dwelling, null);
  sim.running$.next(false);
});

test('even a brief pause immediately interrupts dwell without waiting for the next simulation timer', async () => {
  const sim = simulator();
  sim.setRoomPreset('science');
  sim.running$.next(true);
  sim.pose$.next({ ...explorationPointPosition(EXPLORATION_SCENES[2].points[0]), yaw: 0 });
  await sim.sleep(600);
  assert.equal(sim.explorationProgress$.value.dwellPercent, 60);
  sim.togglePause();
  assert.equal(sim.explorationProgress$.value.dwelling, null);
  sim.togglePause();
  await sim.sleep(600);
  assert.equal(sim.explorationProgress$.value.visited.length, 0);
  await sim.sleep(400);
  assert.deepEqual(plain(sim.explorationProgress$.value.visited), [1]);
  sim.running$.next(false);
});

test('ordinary motion and wait commands can complete all five checkpoints in every museum in a nonnumeric order', async () => {
  for (const scene of EXPLORATION_SCENES) {
    const sim = simulator();
    sim.setRoomPreset(scene.id);
    const route = [4, 1, 3, 0, 2].map(index => scene.points[index]);
    let previous = { forward: 0, left: 0, height: route[0].height };
    const commands = [`cf_motion("takeoff", [${previous.height}, 0.5])`];
    for (const point of route) {
      commands.push(`cf_motion("move", ${JSON.stringify([
        point.forward - previous.forward, point.left - previous.left, point.height - previous.height, 0.5,
      ])})`, 'cf_delay(1.2)');
      previous = point;
    }
    commands.push('cf_motion("land", [0.5])');
    const result = await sim.runCode(commands.join('\n'));
    assert.equal(result.success, true, `${scene.id}: ${result.message}`);
    assert.deepEqual(plain(sim.explorationProgress$.value.visited), [5, 2, 4, 1, 3], scene.id);
    assert.equal(sim.explorationProgress$.value.dwelling, null);
    near(sim.pose$.value.y, 0.06);
    await sim.runCode('cf_print("restart")');
    assert.equal(sim.explorationProgress$.value.visited.length, 0, 'each run resets the completed mission');
  }
});

test('all eleven language resources contain every scene, station and mission label without untranslated keys', () => {
  const english = JSON.parse(fs.readFileSync(path.join(root, 'public', 'i18n', 'en', 'en.json'), 'utf8')).CRAZYFLIE_EXPLORATION;
  const flatten = (value, prefix = '') => Object.entries(value).flatMap(([key, text]) =>
    typeof text === 'string' ? [[`${prefix}${key}`, text]] : flatten(text, `${prefix}${key}.`));
  const keys = flatten(english).map(([key]) => key);
  for (const language of ['zh_cn', 'zh_hk', 'en', 'ja', 'ko', 'de', 'fr', 'es', 'pt', 'ru', 'ar']) {
    const values = JSON.parse(fs.readFileSync(path.join(root, 'public', 'i18n', language, `${language}.json`), 'utf8'));
    for (const key of keys) {
      const text = getTranslation(values, `CRAZYFLIE_EXPLORATION.${key}`);
      assert.equal(typeof text, 'string', `${language}: ${key}`);
      assert.ok(text.trim().length > 0);
    }
    for (const scene of EXPLORATION_SCENES) {
      assert.ok(getTranslation(values, scene.nameKey));
      for (const point of scene.points) assert.ok(getTranslation(values, point.nameKey));
    }
    for (const room of ['MASTER', 'CHILD', 'GUEST', 'LIVING', 'KITCHEN', 'BATHROOM', 'ENTRY', 'BALCONY', 'HALLWAY']) {
      assert.ok(getTranslation(values, `CRAZYFLIE_HOME.${room}`), `${language}: ${room}`);
    }
  }
});

test('mission layout constrains grid width and lets the footer scroll rather than displacing the 220px canvas', () => {
  const stylesheet = path.join(root, 'src', 'app', 'editors', 'blockly-editor', 'components', 'blockly',
    'components', 'crazyflie-sim-panel', 'crazyflie-sim-panel.component.scss');
  const css = require('sass').compile(stylesheet).css;
  assert.match(css, /\.sim-panel\s*\{[^}]*grid-template-columns: minmax\(0, 1fr\)/);
  assert.match(css, /\.sim-panel\s*\{[^}]*grid-template-rows: auto auto minmax\(220px, 1fr\) minmax\(0, auto\)/);
  assert.match(css, /\.sim-panel__footer\s*\{[^}]*min-height: 0;[^}]*overflow-y: auto/);
});

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
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, experimentalDecorators: true, esModuleInterop: true },
  }).outputText;
  vm.runInNewContext(js, {
    exports, console,
    document: { createElement: () => ({ getContext: () => drawing }) },
    setTimeout: fn => { queueMicrotask(fn); return 1; }, clearTimeout() {},
    require: name => {
      if (name === '@angular/core') return { Injectable: () => type => type };
      if (name.startsWith('.')) return name.endsWith('.json') ? require(path.resolve(path.dirname(filename), name))
        : load(path.resolve(path.dirname(filename), `${name}.ts`));
      return require(name);
    },
  });
  return exports;
}
const exploration = load(path.join(services, 'crazyflie-exploration.ts'));
const { EXPLORATION_SCENES, ExplorationTracker, explorationPointPosition, EXPLORATION_RADIUS_M } = exploration;
const themedScenes = EXPLORATION_SCENES.filter(scene => !scene.geography);
const models = load(path.join(services, 'crazyflie-exploration-scene.ts'));
const homes = load(path.join(services, 'crazyflie-home-scene.ts'));
const coordinates = load(path.join(services, 'crazyflie-coordinate-scene.ts'));
const { CrazyflieSimService } = load(path.join(services, 'crazyflie-sim.service.ts'));
const plain = value => JSON.parse(JSON.stringify(value));
const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-6, `${a} != ${b}`);
const simulator = () => new CrazyflieSimService({ setDeckDetected() {} });
const getTranslation = (values, key) => key.split('.').reduce((value, part) => value?.[part], values);

test('coordinate test scene contains only fixed flight-frame axes, meter labels and three perpendicular grids', () => {
  const scene = coordinates.createCoordinateScene();
  try {
    assert.equal(scene.userData.coordinates, true);
    assert.equal(exploration.isSelectableRoomPreset('coordinates'), true);
    assert.equal(exploration.getExplorationScene('coordinates'), undefined);
    const grids = scene.getObjectByName('Coordinate grids');
    let gridCount = 0;
    grids.traverse(node => { if (node instanceof THREE.GridHelper) gridCount++; });
    assert.equal(gridCount, 6);
    const xy = scene.getObjectByName('XY grid 0.1 m');
    const positions = xy.geometry.getAttribute('position');
    near(positions.getZ(4) - positions.getZ(0), 0.1);
    for (const plane of ['XY', 'XZ', 'YZ']) {
      const grid = scene.getObjectByName(`${plane} grid 1 m`);
      scene.updateMatrixWorld(true);
      const bounds = new THREE.Box3().setFromObject(grid);
      const size = bounds.getSize(new THREE.Vector3()).toArray();
      assert.equal(size.filter(value => Math.abs(value - 6) < 1e-6).length, 2);
      assert.equal(size.filter(value => Math.abs(value) < 1e-6).length, 1);
    }
    for (const [label, direction] of [['X', [-1, 0, 0]], ['Y', [0, 0, 1]], ['Z', [0, 1, 0]]]) {
      const axis = scene.getObjectByName(`World ${label} axis`);
      const vector = new THREE.Vector3(...direction);
      near(new THREE.Vector3(0, 1, 0).applyQuaternion(axis.quaternion).distanceTo(vector), 0);
      near(axis.position.distanceTo(vector.multiplyScalar(-3)), 0);
    }
    assert.ok(scene.children.every(node => node instanceof THREE.Group
      || node instanceof THREE.ArrowHelper || node instanceof THREE.Sprite));
    const owned = new Set(), disposed = new Map();
    scene.traverse(node => {
      if (node.isMesh || node.isLine) owned.add(node.geometry);
      if (node.material) {
        for (const material of Array.isArray(node.material) ? node.material : [node.material]) {
          owned.add(material);
          if (material.map) owned.add(material.map);
        }
      }
    });
    owned.forEach(resource => resource.addEventListener('dispose', () =>
      disposed.set(resource, (disposed.get(resource) || 0) + 1)));
    models.disposeExplorationScene(scene);
    for (const resource of owned) assert.equal(disposed.get(resource), 1);
  } catch (error) {
    models.disposeExplorationScene(scene);
    throw error;
  }
});

test('coordinate grid switches from 10 cm to 1 m at the measured 8 CSS pixel density threshold', () => {
  const scene = coordinates.createCoordinateScene();
  const camera = new THREE.PerspectiveCamera(58);
  try {
    for (const height of [220, 400, 800]) for (const zoom of [1, 2]) {
      camera.zoom = zoom;
      const distance = 0.1 * height / (2 * Math.tan(THREE.MathUtils.degToRad(camera.getEffectiveFOV()) / 2) * 8);
      for (const [scale, spacing] of [[0.99, 0.1], [1.01, 1]]) {
        camera.position.set(0, 0, distance * scale);
        assert.equal(coordinates.updateCoordinateGrid(scene, camera, height), spacing);
        assert.equal(scene.getObjectByName('Coordinate minor grid').visible, spacing === 0.1);
        assert.equal(scene.getObjectByName('XY grid 1 m').visible, true);
      }
    }
  } finally { models.disposeExplorationScene(scene); }
});

test('coordinate simulation starts, lands and resets at exact zero and real-follow uses the same launch origin', async () => {
  const sim = simulator();
  sim.setRoomPreset('coordinates');
  const origin = { x: 0, y: 0, z: 0, yaw: 0 };
  assert.deepEqual(plain(sim.pose$.value), origin);
  assert.deepEqual(plain(sim.roomSize$.value), plain(exploration.COORDINATE_ROOM_SIZE));
  const heights = [];
  const sub = sim.pose$.subscribe(pose => heights.push(pose.y));
  const result = await sim.runCode('cf_motion("takeoff", [0.3, 0.5])\ncf_delay(0.1)\ncf_motion("land", [0.5])');
  assert.equal(result.success, true, result.message);
  near(Math.max(...heights), 0.3);
  assert.deepEqual(plain(sim.pose$.value), origin);
  assert.equal(sim.relativeAltitudeCm, 0);
  sub.unsubscribe();
  sim.beginRealFollow();
  assert.throws(() => sim.setRoomPreset('classroom'), /运行期间/);
  const sample = (timestampMs, z) => ({ type: 'sample', timestampMs, roll: 0, pitch: 0, yaw: 0, x: 10, y: 20, z });
  sim.receiveRealPose(sample(0, 2), 0);
  assert.deepEqual(plain(sim.pose$.value), origin);
  sim.receiveRealPose(sample(50, 2.3), 50);
  near(sim.pose$.value.y, 0.3);
  assert.equal(sim.relativeAltitudeCm, 30);
  sim.endRealFollow('done');
  sim.resetPose();
  assert.deepEqual(plain(sim.pose$.value), origin);
  sim.setRoomPreset('classroom');
  near(sim.pose$.value.y, 0.76573);
});

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

test('seven themed scenes each provide five distinct reachable targets alongside two geographic scenes', () => {
  assert.deepEqual(plain(EXPLORATION_SCENES.map(scene => scene.id)), ['animals', 'botanical', 'science', 'space', 'ocean', 'beach', 'farm', 'china', 'world']);
  for (const scene of themedScenes) {
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
  for (const scene of themedScenes) {
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

test('seven themed floor plans have distinct shapes, complete reachable target circles and richer collections', () => {
  const outlines = new Set();
  const coordinates = new Set();
  const overlaps = [];
  for (const scene of themedScenes) {
    outlines.add(JSON.stringify(scene.boundary.map(([x, z]) => [x / scene.size.width, z / scene.size.depth])));
    coordinates.add(JSON.stringify(scene.points.map(point => [point.forward, point.left])));
    if (scene.reference) assert.ok(scene.reference.url.startsWith('https://'));
    assert.ok(withinFloor(scene.boundary, 0, 0), 'launch pad is inside the floor');
    const group = models.createExplorationScene(scene, key => key);
    try {
      assert.ok(group.getObjectByName(`Architecture ${scene.id}`));
      const collections = group.children.filter(child => child.userData.collection);
      assert.equal(collections.length, 10, 'two companion displays per principal collection');
      const displays = group.children.filter(child => child.userData.exhibitId || child.userData.collection || child.userData.discoveryKind);
      const discoveries = group.children.filter(child => child.userData.discoveryKind);
      assert.ok(discoveries.length >= 12, `${scene.id}: needs richer collections`);
      assert.ok(new Set(discoveries.map(child => child.userData.discoveryKind)).size >= (scene.id === 'space' ? 3 : 4));
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
  assert.equal(outlines.size, 7);
  assert.equal(coordinates.size, 7);
  assert.deepEqual(overlaps, []);
});

test('enriching museums preserves all existing target coordinates while the two outdoor scenes provide more area', () => {
  const targets = {
    animals: [[-1.2, -1.2, 0.6], [-5, 2.4, 0.8], [1, 4, 0.6], [4, -3.5, 1], [-4.8, -3, 0.8]],
    botanical: [[-3, 0, 0.9], [-0.4, 3, 0.6], [5, 1.3, 0.7], [3, -1.5, 0.6], [-5, -2.4, 0.8]],
    science: [[-3, 0, 0.8], [-6, 3.3, 1], [5, -3.5, 0.9], [5, 1.5, 0.6], [-6, -1, 0.8]],
    space: [[-5, 3.8, 0.8], [-5, -3.4, 1.2], [5, -3.8, 1.1], [5, 3.8, 0.6], [0, 1.4, 1]],
    ocean: [[-4, -3.7, 0.6], [1, -3.2, 0.8], [4.5, -1.8, 1.1], [4.2, 2.6, 0.7], [-3.7, 3.7, 0.9]],
  };
  for (const [id, positions] of Object.entries(targets)) {
    assert.deepEqual(plain(exploration.getExplorationScene(id).points.map(point => [-point.forward, point.left, point.height])), positions);
  }
  for (const id of ['beach', 'farm']) {
    const { size } = exploration.getExplorationScene(id);
    assert.ok(size.width * size.depth > 18 * 14);
  }
});

test('the garden apartment has full-height white walls without filling doorways or floor-to-ceiling windows', () => {
  const home = homes.createHomeScene(key => key);
  try {
    home.updateMatrixWorld(true);
    const walls = [];
    const openings = [];
    home.traverse(node => {
      if (node.userData.apartmentWall) walls.push(node);
      if (node.name === 'Open apartment doorway' || node.name === 'Floor-to-ceiling window') openings.push(node);
    });
    assert.ok(walls.some(node => node.userData.apartmentWall === 'interior'), 'bedrooms, kitchen and bathroom need partition walls');
    assert.ok(walls.some(node => node.userData.apartmentWall === 'exterior'), 'the apartment needs exterior walls');
    const bounds = walls.map(node => {
      assert.equal(node.material.color.getHexString(), 'f8f8f5');
      assert.equal(node.material.transparent, false);
      const bounds = new THREE.Box3().setFromObject(node);
      near(bounds.max.y, 2.7);
      return bounds;
    });
    for (const [x, z] of [[-4.8, -1.4], [-2.6, -4.1], [-2.6, 1.8], [1.8, -4.2],
      [3.4, -4.2], [-1.6, -2.8], [1.2, -2.8], [6, -1.5], [0, -5.95], [-1.7, 3.35]]) {
      assert.ok(bounds.some(box => box.containsPoint(new THREE.Vector3(x, 1.5, z))), `missing room wall at ${x}, ${z}`);
    }
    for (const opening of openings) {
      const door = opening.name === 'Open apartment doorway';
      const width = opening.userData.clearWidth;
      assert.ok(Number.isFinite(width) && width >= 1.1);
      if (door) near(opening.userData.clearHeight, 2.2);
      for (const offset of [-0.49, 0, 0.49]) {
        for (const y of door ? [0.1, 1.1, 2.15] : [0.1, 1.3, 2.5]) {
          const point = opening.localToWorld(new THREE.Vector3(width * offset, y, 0));
          assert.ok(!bounds.some(box => box.containsPoint(point)), `${opening.name} is blocked at ${point.toArray()}`);
        }
      }
      if (door) {
        const header = opening.localToWorld(new THREE.Vector3(0, 2.5, 0));
        assert.ok(bounds.some(box => box.containsPoint(header)), 'a doorway needs a white lintel above its frame');
      }
    }
  } finally {
    models.disposeExplorationScene(home);
  }
});

test('the garden apartment equips each room with basic furniture and keeps furniture outside the doorways', () => {
  const home = homes.createHomeScene(key => key);
  try {
    home.updateMatrixWorld(true);
    const rooms = new Map(home.children.filter(node => node.userData.room).map(node => [node.userData.room, node]));
    const required = {
      MASTER: ['Apartment bed', 'Bedroom wardrobe', 'Bedside cabinet', 'Table lamp', 'Wall air conditioner'],
      CHILD: ['Apartment bed', 'Bedroom wardrobe', 'Bedside cabinet', 'Study desk', 'Apartment chair', 'Study book', 'Children bookshelf', 'Wall air conditioner'],
      GUEST: ['Apartment bed', 'Bedroom wardrobe', 'Bedside cabinet', 'Study desk', 'Apartment chair', 'Wall air conditioner'],
      LIVING: ['Living room sofa', 'Coffee table', 'Living room rug', 'Television', 'Television console', 'Floor lamp'],
      ENTRY: ['Entry shoe cabinet', 'Entry mirror', 'Entry bench', 'Coat rack', 'Apartment chair', 'Fruit bowl'],
      KITCHEN: ['Kitchen sink', 'Kitchen extractor', 'Refrigerator', 'Kitchen wall cabinet', 'Microwave', 'Built-in oven', 'Kitchen waste bin'],
      BATHROOM: ['Toilet bowl', 'Bathroom vanity', 'Bathroom basin', 'Bathroom mirror', 'Towel rail', 'Shower tray'],
      BALCONY: ['Sky garden lawn', 'Washing machine', 'Laundry storage'],
    };
    for (const [id, names] of Object.entries(required)) {
      const room = rooms.get(id);
      assert.ok(room, id);
      for (const name of names) {
        const furnishing = room.getObjectByName(name);
        assert.ok(furnishing, `${id} needs ${name}`);
        const bounds = new THREE.Box3().setFromObject(furnishing);
        assert.ok(!bounds.isEmpty(), `${id}: ${name} must have actual geometry`);
        assert.ok(bounds.min.x >= -7 && bounds.max.x <= 7 && bounds.min.z >= -6 && bounds.max.z <= 6,
          `${id}: ${name} overhangs the apartment floor`);
      }
    }
    const meshBounds = [];
    home.traverse(node => { if (node.isMesh) meshBounds.push({ name: node.name, bounds: new THREE.Box3().setFromObject(node) }); });
    for (const doorway of home.children.filter(node => node.name === 'Open apartment doorway')) {
      for (const offset of [-0.49, 0, 0.49]) for (const y of [0.1, 1.1, 2.15]) {
        const point = doorway.localToWorld(new THREE.Vector3(doorway.userData.clearWidth * offset, y, 0));
        for (const mesh of meshBounds) assert.ok(!mesh.bounds.containsPoint(point), `${mesh.name} fills a door opening at ${point.toArray()}`);
      }
    }
  } finally {
    models.disposeExplorationScene(home);
  }
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
  for (const scene of themedScenes) {
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
      for (const point of scene.points) if (!point.region) assert.ok(getTranslation(values, point.nameKey));
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
  assert.match(css, /\.sim-panel\s*\{[^}]*grid-template-rows: auto auto minmax\(min-content, 1fr\) minmax\(0, auto\)/);
  assert.match(css, /\.sim-panel__canvas-wrap\s*\{[^}]*grid-template-rows: minmax\(220px, 1fr\) auto/);
  assert.match(css, /\.sim-panel__canvas\s*\{[^}]*min-height: 220px/);
  assert.match(css, /\.sim-panel__footer\s*\{[^}]*min-height: 48px;[^}]*overflow-y: auto/);
  assert.match(css, /\.sim-panel__footer:has\(\.sim-mission\)\s*\{[^}]*min-height: 96px/);
  assert.match(css, /\.sim-panel__footer\s*\{[^}]*max-height: 280px/);
});

test('scene selector and view controls use themed native options in one scrollable toolbar', () => {
  const stylesheet = path.join(root, 'src', 'app', 'editors', 'blockly-editor', 'components', 'blockly',
    'components', 'crazyflie-sim-panel', 'crazyflie-sim-panel.component.scss');
  const css = require('sass').compile(stylesheet).css;
  assert.match(css, /\.sim-panel\s*\{[^}]*grid-template-columns: minmax\(0, 1fr\)/);
  assert.match(css, /\.sim-scene-select\s*\{[^}]*flex: 0 0 72px;[^}]*width: 72px;[^}]*min-width: 0;[^}]*max-width: 72px/);
  assert.match(css, /\.sim-scene-select\s*\{[^}]*background-color: var\(--aily-bg-tertiary\);[^}]*color: var\(--aily-text-primary\);[^}]*color-scheme: dark/);
  assert.match(css, /\.sim-scene-select option\s*\{[^}]*background-color: var\(--aily-bg-tertiary\);[^}]*color: var\(--aily-text-primary\)/);
  assert.match(css, /:host-context\(\[data-theme=['"]?light['"]?\]\) \.sim-scene-select\s*\{[^}]*color-scheme: light/);
  assert.match(css, /\.sim-panel__controls\s*\{[^}]*align-items: center;[^}]*flex-wrap: nowrap;[^}]*min-width: 0;[^}]*overflow-x: auto/);
  assert.match(css, /\.sim-panel__controls > \.sim-btn\s*\{[^}]*flex: 0 0 auto;[^}]*white-space: nowrap/);
  assert.match(css, /\.sim-view-tools\s*\{[^}]*flex-wrap: nowrap;[^}]*flex: 0 0 auto/);
  const chinese = JSON.parse(fs.readFileSync(path.join(root, 'public', 'i18n', 'zh_cn', 'zh_cn.json'), 'utf8'));
  for (const scene of exploration.CRAZYFLIE_SCENE_OPTIONS) assert.ok(getTranslation(chinese, scene.nameKey).length <= 3);
});

test('geographic data covers 34 Chinese divisions including Taiwan and 239 world countries/regions with interior targets', () => {
  const data = require(path.join(services, 'data', 'crazyflie-geography.json'));
  assert.equal(data.source.license, 'Public domain');
  for (const file of data.source.files) assert.match(file.sha256, /^[0-9a-f]{64}$/);
  assert.equal(data.china.length, 34);
  for (const code of ['CN-TW', 'CN-HK', 'CN-MO', 'CN-BJ', 'CN-XJ', 'CN-XZ', 'CN-HI']) {
    assert.ok(data.china.some(region => region.code === code));
  }
  assert.equal(data.china.find(region => region.code === 'CN-TW').nameZh, '台湾省');
  assert.equal(data.world.length, 239);
  for (const code of ['CHN', 'USA', 'RUS', 'IND', 'JPN', 'SGP', 'VAT', 'MCO']) assert.ok(data.world.some(region => region.code === code), code);
  for (const regions of [data.china, data.world]) {
    assert.equal(new Set(regions.map(region => region.code)).size, regions.length);
    for (const region of regions) {
      const [x, z] = region.center;
      assert.ok(region.polygons.some(polygon => withinFloor(polygon[0], x, z)
        && !polygon.slice(1).some(hole => withinFloor(hole, x, z))), `${region.code}: target not inside its geographic boundary`);
    }
  }
});

test('geographic scenes build colored borders and exactly one reusable selected target, suppress real-mode targets and dispose once', () => {
  for (const scene of EXPLORATION_SCENES.filter(scene => scene.geography)) {
    const group = models.createExplorationScene(scene, key => key, 'zh_cn');
    try {
      const regions = group.children.filter(node => node.userData.regionId);
      assert.equal(regions.length, scene.points.length);
      const target = group.getObjectByName('Geography target');
      assert.equal(target.visible, false);
      let meshes = 0, vertices = 0;
      const owned = new Set(), disposed = new Map();
      group.traverse(node => {
        if (node.isMesh || node.isLine) { meshes++; vertices += node.geometry.attributes.position.count; owned.add(node.geometry); }
        if (node.material) { owned.add(node.material); if (node.material.map) owned.add(node.material.map); }
      });
      assert.ok(meshes < 600, `${scene.id}: ${meshes} meshes`);
      assert.ok(vertices < 600000, `${scene.id}: ${vertices} vertices`);
      const bounds = new THREE.Box3().setFromObject(group);
      assert.ok(bounds.min.x >= -scene.size.width / 2 - 0.15 && bounds.max.x <= scene.size.width / 2 + 0.15);
      assert.ok(bounds.min.z >= -scene.size.depth / 2 - 0.15 && bounds.max.z <= scene.size.depth / 2 + 0.15);
      const geometries = new Set();
      group.traverse(node => { if (node.isMesh) geometries.add(node.geometry); });
      for (const point of scene.points) {
        models.updateExplorationMarkers(group, { visited: [], dwelling: null, dwellPercent: 0 }, true, point.id);
        assert.equal(target.visible, true);
        const position = explorationPointPosition(point);
        near(target.position.x, position.x);
        near(target.position.z, position.z);
        assert.equal(group.getObjectByName('Geography target'), target);
      }
      const after = new Set();
      group.traverse(node => { if (node.isMesh) after.add(node.geometry); });
      assert.equal(after.size, geometries.size, 'selection must not create new geometry');
      models.updateExplorationMarkers(group, { visited: [], dwelling: null, dwellPercent: 0 }, false, 1);
      assert.equal(target.visible, false);
      models.updateExplorationMarkers(group, { visited: [], dwelling: null, dwellPercent: 0 }, true, null);
      assert.equal(target.visible, false);
      owned.forEach(resource => resource.addEventListener('dispose', () => disposed.set(resource, (disposed.get(resource) || 0) + 1)));
      models.disposeExplorationScene(group);
      for (const resource of owned) assert.equal(disposed.get(resource), 1);
    } catch (error) {
      models.disposeExplorationScene(group);
      throw error;
    }
  }
});

test('map scoring only considers the selected region and switching nearby targets interrupts the full-second dwell', () => {
  const a = EXPLORATION_SCENES[0].points[0], b = { ...a, id: 2 };
  const tracker = new ExplorationTracker([a, b]), target = explorationPointPosition(a);
  tracker.update(target, 0, true, null);
  assert.equal(tracker.update(target, 2000, true, null).visited.length, 0);
  tracker.update(target, 2100, true, a.id);
  tracker.update(target, 3099, true, b.id);
  assert.equal(tracker.update(target, 4098, true, b.id).visited.length, 0);
  assert.deepEqual(plain(tracker.update(target, 4099, true, b.id).visited), [b.id]);
  tracker.update(target, 4100, true, a.id);
  assert.deepEqual(plain(tracker.update(target, 5100, true, a.id).visited), [b.id, a.id]);
});

test('the real simulator can fly a selected Taiwan checkpoint without scoring unselected map regions or moving on selection', async () => {
  const sim = simulator();
  sim.setRoomPreset('china');
  const scene = exploration.getExplorationScene('china');
  const taiwan = scene.points.find(point => point.region.code === 'CN-TW');
  const before = plain(sim.pose$.value);
  sim.setMapTarget(taiwan.id);
  assert.deepEqual(plain(sim.pose$.value), before);
  assert.throws(() => sim.setMapTarget(99999), /地图区域/);
  const result = await sim.runCode(`cf_motion("takeoff", [0.8, 0.5])\ncf_motion("move", [${taiwan.forward}, ${taiwan.left}, 0, 0.5])\ncf_delay(1.2)\ncf_motion("land", [0.5])`);
  assert.equal(result.success, true, result.message);
  assert.deepEqual(plain(sim.explorationProgress$.value.visited), [taiwan.id]);
  sim.resetExploration();
  sim.setMapTarget(null);
  sim.running$.next(true);
  sim.pose$.next({ ...explorationPointPosition(taiwan), yaw: 0 });
  await sim.sleep(1500);
  assert.equal(sim.explorationProgress$.value.visited.length, 0);
  sim.running$.next(false);
  sim.setRoomPreset('world');
  assert.equal(sim.mapTargetId$.value, null);
});

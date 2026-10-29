const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');
const ts = require('typescript');
const THREE = require('three');
const services = path.join(__dirname, '..', 'src', 'app', 'services');
function load(name) {
  const exports = {};
  const js = ts.transpileModule(fs.readFileSync(path.join(services, `${name}.ts`), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  vm.runInNewContext(js, { exports, document: { createElement: () => ({
    getContext: () => ({ beginPath() {}, arc() {}, fill() {}, fillText() {} }),
  }) }, require: name => name === 'three' ? THREE
    : name === './crazyflie-attitude' ? load('crazyflie-attitude') : require(name) });
  return exports;
}
const { CrazyflieAttitudePreview } = load('crazyflie-attitude-preview');
const { attitudeQuaternion } = load('crazyflie-attitude');
const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-6, `${a} != ${b}`);

test('independent aircraft preview centers either model size, shares assets and never changes the classroom model', () => {
  const source = new THREE.Group();
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(2, 1, 4), new THREE.MeshStandardMaterial());
  mesh.position.set(10, -20, 100);
  source.add(mesh);
  source.position.set(8, 0.77, -4);
  source.rotation.set(0.1, 2, 0.3);
  const position = source.position.clone(), rotation = source.quaternion.clone();
  const preview = new CrazyflieAttitudePreview();
  preview.setModel(source);
  const clone = preview.aircraft.children[0];
  assert.notEqual(clone, source);
  assert.equal(clone.children[0].geometry, mesh.geometry);
  assert.equal(clone.children[0].material, mesh.material);
  near(new THREE.Box3().setFromObject(clone).getCenter(new THREE.Vector3()).length(), 0);
  near(new THREE.Box3().setFromObject(clone).getBoundingSphere(new THREE.Sphere()).radius, 0.6);
  const sample = { type: 'sample', timestampMs: 50, roll: 30, pitch: -20, yaw: 80 };
  for (let i = 0; i < 40; i++) preview.update(sample, 1 / 60);
  near(preview.aircraft.quaternion.angleTo(attitudeQuaternion(30, -20, 80, Math.PI)), 0);
  near(source.position.distanceTo(position), 0);
  near(source.quaternion.angleTo(rotation), 0);
  preview.update(null, 1 / 60);
  near(preview.aircraft.quaternion.angleTo(attitudeQuaternion(0, 0, 0, Math.PI)), 0);
  let geometryDisposed = 0, materialDisposed = 0;
  let labelTexturesDisposed = 0;
  const labels = preview.axes.children.filter(child => child.isSprite);
  for (const label of labels) label.material.map.addEventListener('dispose', () => { labelTexturesDisposed++; });
  mesh.geometry.addEventListener('dispose', () => { geometryDisposed++; });
  mesh.material.addEventListener('dispose', () => { materialDisposed++; });
  preview.setModel(source);
  assert.equal(preview.axes.children.length, 6, 'replacing the aircraft must not duplicate body axes or labels');
  preview.dispose();
  assert.equal(geometryDisposed, 0);
  assert.equal(materialDisposed, 0);
  assert.equal(labelTexturesDisposed, 3, 'owned coordinate-label textures must be released');
  mesh.geometry.dispose();
  mesh.material.dispose();
});

function rendererHarness(fail = false) {
  const viewport = new THREE.Vector4(0, 0, 640, 480), scissor = new THREE.Vector4(10, 20, 30, 40);
  const color = new THREE.Color('#fafafa');
  let alpha = 0.5, scissorTest = false;
  const calls = [];
  const assign = (target, args) => args[0]?.isVector4 ? target.copy(args[0]) : target.set(...args);
  const renderer = {
    autoClear: false,
    getViewport: target => target.copy(viewport), getScissor: target => target.copy(scissor),
    getClearColor: target => target.copy(color), getClearAlpha: () => alpha, getScissorTest: () => scissorTest,
    setViewport: (...args) => assign(viewport, args), setScissor: (...args) => assign(scissor, args),
    setClearColor: (value, valueAlpha) => { color.copy(value); alpha = valueAlpha; },
    setScissorTest: value => { scissorTest = value; },
    render: (scene, camera) => {
      calls.push({ scene, camera, viewport: viewport.clone(), scissor: scissor.clone(), scissorTest });
      if (fail) throw new Error('test renderer failure');
    },
  };
  return { renderer, viewport, scissor, color, calls, get alpha() { return alpha; }, get scissorTest() { return scissorTest; } };
}

test('inset uses a scissored second view in the existing renderer and restores the main scene state even on error', () => {
  for (const fail of [false, true]) {
    const preview = new CrazyflieAttitudePreview();
    const h = rendererHarness(fail);
    const render = () => preview.render(h.renderer, { x: 470, y: 8, width: 160, height: 100 });
    if (fail) assert.throws(render, /renderer failure/); else render();
    assert.equal(h.calls.length, 1);
    assert.deepEqual(h.calls[0].viewport.toArray(), [470, 8, 160, 100]);
    assert.deepEqual(h.calls[0].scissor.toArray(), [470, 8, 160, 100]);
    assert.equal(h.calls[0].scissorTest, true);
    near(preview.camera.aspect, 1.6);
    assert.deepEqual(h.viewport.toArray(), [0, 0, 640, 480]);
    assert.deepEqual(h.scissor.toArray(), [10, 20, 30, 40]);
    assert.equal(h.scissorTest, false);
    assert.equal(h.renderer.autoClear, false);
    near(h.alpha, 0.5);
    assert.equal(h.color.getHexString(), 'fafafa');
    preview.dispose();
  }
});

test('body axes follow firmware X-forward Y-left Z-up without the model heading offset', () => {
  const preview = new CrazyflieAttitudePreview();
  for (const [roll, pitch, yaw, expected] of [
    [0, 0, 0, [[-1, 0, 0], [0, 0, 1], [0, 1, 0]]],
    [0, 0, 90, [[0, 0, 1], [1, 0, 0], [0, 1, 0]]],
    [0, 0, -90, [[0, 0, -1], [-1, 0, 0], [0, 1, 0]]],
    [90, 0, 0, [[-1, 0, 0], [0, 1, 0], [0, 0, -1]]],
    [0, 90, 0, [[0, 1, 0], [0, 0, 1], [1, 0, 0]]],
    [90, 90, 90, [[0, 1, 0], [0, 0, -1], [-1, 0, 0]]],
  ]) {
    preview.update({ type: 'sample', timestampMs: 50, roll, pitch, yaw }, 1);
    const directions = ['X', 'Y', 'Z'].map((name, index) => {
      const arrow = preview.axes.getObjectByName(`Body axis ${name}`);
      const direction = new THREE.Vector3(0, 1, 0).applyQuaternion(arrow.getWorldQuaternion(new THREE.Quaternion()));
      near(direction.distanceTo(new THREE.Vector3(...expected[index])), 0);
      const label = preview.axes.getObjectByName(`Body label ${name}`);
      near(label.getWorldPosition(new THREE.Vector3()).normalize().distanceTo(direction), 0);
      return direction;
    });
    near(directions[0].clone().cross(directions[1]).dot(directions[2]), 1);
    for (const [index, local] of [[0, [1, 0, 0]], [1, [0, 0, -1]], [2, [0, 1, 0]]]) {
      near(new THREE.Vector3(...local).applyQuaternion(preview.aircraft.quaternion).distanceTo(directions[index]), 0);
    }
  }
  preview.update(null, 1 / 60);
  near(preview.axes.quaternion.angleTo(new THREE.Quaternion()), 0);
  preview.dispose();
});

test('normalized aircraft, body arrows and labeled tips stay inside compact and normal views at all attitudes', () => {
  const preview = new CrazyflieAttitudePreview();
  const source = new THREE.Group();
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(1, 0.1, 1), new THREE.MeshStandardMaterial());
  source.add(mesh);
  preview.setModel(source);
  preview.camera.updateMatrixWorld(true);
  const model = preview.aircraft.children[0];
  const positions = model.children[0].geometry.getAttribute('position');
  for (const [width, height] of [[136, 82], [154, 112], [184, 124], [100, 100]]) {
    preview.render(rendererHarness().renderer, { x: 0, y: 0, width, height });
    for (const roll of [-180, -90, -45, 0, 45, 90, 180]) {
      for (const pitch of [-90, 0, 90]) {
        for (const yaw of [-179, 0, 90, 179]) {
          preview.update({ type: 'sample', timestampMs: 50, roll, pitch, yaw }, 1);
          preview.scene.updateMatrixWorld(true);
          for (let i = 0; i < positions.count; i++) {
            const projected = new THREE.Vector3().fromBufferAttribute(positions, i)
              .applyMatrix4(model.children[0].matrixWorld).project(preview.camera);
            assert.ok(Math.abs(projected.x) < 1 && Math.abs(projected.y) < 1 && Math.abs(projected.z) < 1,
              `clipped aircraft at roll=${roll}, pitch=${pitch}, yaw=${yaw}`);
          }
          for (const axis of ['X', 'Y', 'Z']) {
            const label = preview.axes.getObjectByName(`Body label ${axis}`);
            const projected = label.getWorldPosition(new THREE.Vector3()).project(preview.camera);
            assert.ok(Math.abs(projected.x) + 14 / width < 1 && Math.abs(projected.y) + 14 / height < 1,
              `clipped ${axis} label at ${width}x${height}, roll=${roll}, pitch=${pitch}, yaw=${yaw}`);
            near(label.scale.x * height / (2 * Math.tan(THREE.MathUtils.degToRad(preview.camera.fov) / 2)), 14);
          }
        }
      }
    }
  }
  preview.dispose();
  mesh.geometry.dispose();
  mesh.material.dispose();
});

test('one upper-right attitude widget replaces the old compass while retaining the main view selector', () => {
  const panel = path.join(__dirname, '..', 'src', 'app', 'editors', 'blockly-editor', 'components',
    'blockly', 'components', 'crazyflie-sim-panel', 'crazyflie-sim-panel.component');
  const html = fs.readFileSync(`${panel}.html`, 'utf8');
  const source = fs.readFileSync(`${panel}.ts`, 'utf8');
  const style = require('sass').compile(`${panel}.scss`).css;
  assert.equal((html.match(/class="sim-attitude-inset"/g) || []).length, 1);
  assert.doesNotMatch(html + source, /orientationCanvas|drawOrientationCompass|class="sim-orientation"/);
  assert.match(html, /X 前（红）、Y 左（绿）、Z 上（蓝）/);
  assert.match(html, /class="sim-attitude-inset__view"[^>]+aria-label="主场景标准视角"/);
  assert.equal((html.match(/\(change\)="setCameraView\(/g) || []).length, 1);
  assert.match(style, /\.sim-attitude-inset\s*\{[^}]*top: 8px/);
  assert.match(style, /\.sim-attitude-inset\s*\{[^}]*position: absolute;[^}]*right: 8px/);
  assert.match(style, /\.sim-attitude-inset__viewport\s*\{[^}]*height: clamp\(96px, 14vh, 124px\)/);
  assert.doesNotMatch(style, /\.sim-attitude-inset\s*\{[^}]*bottom:/);
});

import { AmbientLight, ArrowHelper, Box3, CanvasTexture, Color, DirectionalLight, Group, MathUtils,
  PerspectiveCamera, Scene, Sphere, Sprite, SpriteMaterial, SRGBColorSpace, Vector3, Vector4, WebGLRenderer } from 'three';
import { AttitudeSample, attitudeQuaternion, CRAZYFLIE_BODY_AXES } from './crazyflie-attitude';

export class CrazyflieAttitudePreview {
  readonly scene = new Scene();
  readonly camera = new PerspectiveCamera(38, 1, 0.01, 10);
  readonly aircraft = new Group();
  readonly axes = new Group();
  private readonly modelOffsetInverse = attitudeQuaternion(0, 0, 0, -Math.PI);
  private readonly viewport = new Vector4();
  private readonly scissor = new Vector4();
  private readonly clearColor = new Color();

  constructor() {
    this.scene.background = new Color('#d9e3eb');
    this.camera.position.set(1.2, 1.8, 1.2);
    this.camera.lookAt(0, 0, 0);
    const light = new DirectionalLight('#ffffff', 2);
    light.position.set(2, 4, 3);
    this.scene.add(new AmbientLight('#ffffff', 2), light, this.aircraft, this.axes);
    this.axes.name = 'Aircraft body coordinates: X forward, Y left, Z up';
    for (const axis of CRAZYFLIE_BODY_AXES) {
      const arrow = new ArrowHelper(axis.direction, new Vector3(), 0.6, axis.color, 0.1, 0.055);
      arrow.name = `Body axis ${axis.label}`;
      const label = this.createAxisLabel(axis.label, axis.color);
      label.name = `Body label ${axis.label}`;
      label.position.copy(axis.direction).multiplyScalar(0.65);
      this.axes.add(arrow, label);
    }
    this.aircraft.quaternion.copy(attitudeQuaternion(0, 0, 0, Math.PI));
  }

  private createAxisLabel(text: string, color: string): Sprite {
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 64;
    const context = canvas.getContext('2d');
    if (!context) throw new Error('无法绘制飞行器坐标标签');
    context.fillStyle = color;
    context.beginPath();
    context.arc(32, 32, 29, 0, Math.PI * 2);
    context.fill();
    context.fillStyle = '#ffffff';
    context.font = 'bold 40px sans-serif';
    context.textAlign = 'center';
    context.textBaseline = 'middle';
    context.fillText(text, 32, 34);
    const texture = new CanvasTexture(canvas);
    texture.colorSpace = SRGBColorSpace;
    const label = new Sprite(new SpriteMaterial({
      map: texture, depthTest: false, depthWrite: false, toneMapped: false, sizeAttenuation: false,
    }));
    label.renderOrder = 10;
    return label;
  }

  setModel(source: Group): void {
    const model = source.clone(true);
    model.position.set(0, 0, 0);
    model.quaternion.identity();
    const bounds = new Box3().setFromObject(model);
    const sphere = bounds.getBoundingSphere(new Sphere());
    if (!Number.isFinite(sphere.radius) || sphere.radius <= 0) throw new Error('姿态预览模型尺寸无效');
    const scale = 0.6 / sphere.radius;
    model.position.copy(sphere.center).multiplyScalar(-scale);
    model.scale.multiplyScalar(scale);
    // Clones share geometry/textures with the scene model; only the owner disposes them.
    this.aircraft.clear();
    this.aircraft.add(model);
  }

  update(sample: AttitudeSample | null, deltaSec: number): void {
    const target = attitudeQuaternion(sample?.roll ?? 0, sample?.pitch ?? 0, sample?.yaw ?? 0, Math.PI);
    if (!sample) this.aircraft.quaternion.copy(target);
    else this.aircraft.quaternion.slerp(target, 1 - Math.exp(-Math.max(0, deltaSec) / 0.035));
    this.axes.quaternion.copy(this.aircraft.quaternion).multiply(this.modelOffsetInverse);
  }

  render(renderer: WebGLRenderer, rect: { x: number; y: number; width: number; height: number }): void {
    if (rect.width <= 0 || rect.height <= 0) return;
    renderer.getViewport(this.viewport);
    renderer.getScissor(this.scissor);
    renderer.getClearColor(this.clearColor);
    const clearAlpha = renderer.getClearAlpha();
    const scissorTest = renderer.getScissorTest();
    const autoClear = renderer.autoClear;
    try {
      this.camera.aspect = rect.width / rect.height;
      this.camera.updateProjectionMatrix();
      const labelSize = 2 * 14 * Math.tan(MathUtils.degToRad(this.camera.fov) / 2) / rect.height;
      for (const child of this.axes.children) {
        if (child instanceof Sprite) child.scale.set(labelSize, labelSize, 1);
      }
      renderer.setViewport(rect.x, rect.y, rect.width, rect.height);
      renderer.setScissor(rect.x, rect.y, rect.width, rect.height);
      renderer.setScissorTest(true);
      renderer.autoClear = true;
      renderer.render(this.scene, this.camera);
    } finally {
      renderer.autoClear = autoClear;
      renderer.setClearColor(this.clearColor, clearAlpha);
      renderer.setScissorTest(scissorTest);
      renderer.setViewport(this.viewport);
      renderer.setScissor(this.scissor);
    }
  }

  dispose(): void {
    for (const child of this.axes.children) {
      if (child instanceof ArrowHelper) child.dispose();
      else if (child instanceof Sprite) {
        child.material.map?.dispose();
        child.material.dispose();
      }
    }
    this.aircraft.clear();
    this.axes.clear();
    this.scene.clear();
  }
}

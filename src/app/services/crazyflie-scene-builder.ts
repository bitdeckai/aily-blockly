import {
  BoxGeometry, BufferGeometry, CanvasTexture, CylinderGeometry, ExtrudeGeometry, Group, Mesh,
  MeshStandardMaterial, Shape, SphereGeometry, Sprite, SpriteMaterial, SRGBColorSpace, TorusGeometry, Vector3,
} from 'three';

export function createSceneBuilder(accent: string) {
  const paints = new Map<string, MeshStandardMaterial>();
  const paint = (color: string, metalness = 0.05): MeshStandardMaterial => {
    const key = `${color}:${metalness}`;
    let material = paints.get(key);
    if (!material) {
      material = new MeshStandardMaterial({ color, roughness: 0.72, metalness });
      paints.set(key, material);
    }
    return material;
  };
  const add = (parent: Group, geometry: BufferGeometry, material: MeshStandardMaterial,
    x: number, y: number, z: number): Mesh => {
    const mesh = new Mesh(geometry, material);
    mesh.position.set(x, y, z);
    parent.add(mesh);
    return mesh;
  };
  const box = (parent: Group, material: MeshStandardMaterial, x: number, y: number, z: number,
    w: number, h: number, d: number): Mesh => add(parent, new BoxGeometry(w, h, d), material, x, y, z);
  const ball = (parent: Group, material: MeshStandardMaterial, x: number, y: number, z: number,
    sx: number, sy = sx, sz = sx): Mesh => {
    const mesh = add(parent, new SphereGeometry(1, 16, 12), material, x, y, z);
    mesh.scale.set(sx, sy, sz);
    return mesh;
  };
  const cylinder = (parent: Group, material: MeshStandardMaterial, x: number, y: number, z: number,
    radius: number, height: number, topRadius = radius): Mesh =>
    add(parent, new CylinderGeometry(topRadius, radius, height, 24), material, x, y, z);
  const rod = (parent: Group, material: MeshStandardMaterial, from: Vector3, to: Vector3, radius: number): Mesh => {
    const mesh = cylinder(parent, material, 0, 0, 0, radius, from.distanceTo(to));
    mesh.position.copy(from).add(to).multiplyScalar(0.5);
    mesh.quaternion.setFromUnitVectors(new Vector3(0, 1, 0), to.clone().sub(from).normalize());
    return mesh;
  };
  const ring = (parent: Group, material: MeshStandardMaterial, radius: number, tube: number,
    x: number, y: number, z: number): Mesh =>
    add(parent, new TorusGeometry(radius, tube, 8, 48), material, x, y, z);
  const label = (parent: Group, content: string, x: number, y: number, z: number, width: number, number = false): Sprite => {
    const canvas = document.createElement('canvas');
    canvas.width = number ? 128 : 512;
    canvas.height = 128;
    const context = canvas.getContext('2d');
    if (!context) throw new Error('Cannot create exploration labels: Canvas 2D is unavailable');
    context.fillStyle = number ? '#253f4e' : '#f5eddc';
    context.beginPath();
    context.roundRect(4, 4, canvas.width - 8, 120, number ? 60 : 22);
    context.fill();
    context.strokeStyle = accent;
    context.lineWidth = 6;
    context.stroke();
    context.fillStyle = number ? '#fff3d6' : '#314752';
    context.textAlign = 'center';
    context.textBaseline = 'middle';
    context.font = `600 ${number ? 78 : 42}px system-ui, sans-serif`;
    context.fillText(content, canvas.width / 2, 67, canvas.width - 32);
    const texture = new CanvasTexture(canvas);
    texture.colorSpace = SRGBColorSpace;
    const sprite = new Sprite(new SpriteMaterial({ map: texture, toneMapped: false }));
    sprite.position.set(x, y, z);
    sprite.scale.set(width, width * canvas.height / canvas.width, 1);
    parent.add(sprite);
    return sprite;
  };
  const floor = (parent: Group, boundary: readonly (readonly [number, number])[], color: string): Mesh => {
    const shape = new Shape();
    boundary.forEach(([x, z], i) => i ? shape.lineTo(x, -z) : shape.moveTo(x, -z));
    shape.closePath();
    const mesh = add(parent, new ExtrudeGeometry(shape, { depth: 0.12, bevelEnabled: false }), paint(color), 0, -0.13, 0);
    mesh.rotation.x = -Math.PI / 2;
    mesh.name = 'Architectural floor';
    mesh.userData.boundary = boundary;
    return mesh;
  };
  const wall = (parent: Group, from: readonly [number, number], to: readonly [number, number],
    color: string, height = 0.85, thickness = 0.12): Mesh => {
    const [x, z] = from, [endX, endZ] = to;
    const mesh = box(parent, paint(color), (x + endX) / 2, height / 2, (z + endZ) / 2,
      Math.hypot(endX - x, endZ - z), height, thickness);
    mesh.rotation.y = -Math.atan2(endZ - z, endX - x);
    mesh.name = 'Cutaway wall';
    return mesh;
  };
  const pad = (parent: Group): void => {
    const cream = paint('#f4e8d1');
    cylinder(parent, paint('#334652'), 0, 0.015, 0, 0.4, 0.03);
    cylinder(parent, paint('#d8753f'), 0, 0.035, 0, 0.35, 0.01);
    ring(parent, cream, 0.29, 0.014, 0, 0.045, 0).rotation.x = -Math.PI / 2;
    for (const x of [-0.08, 0.08]) box(parent, cream, x, 0.047, 0, 0.024, 0.006, 0.22);
    box(parent, cream, 0, 0.047, 0, 0.18, 0.006, 0.025);
  };
  return { paint, add, box, ball, cylinder, rod, ring, label, floor, wall, pad };
}

export type SceneBuilder = ReturnType<typeof createSceneBuilder>;

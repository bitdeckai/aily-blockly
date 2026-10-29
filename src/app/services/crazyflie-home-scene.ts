import { DoubleSide, Group, MeshStandardMaterial, Vector3 } from 'three';
import { createSceneBuilder } from './crazyflie-scene-builder';

export function createHomeScene(text: (key: string) => string): Group {
  const root = new Group();
  root.name = 'Garden apartment';
  root.userData.home = true;
  const b = createSceneBuilder('#ba9569');
  const { paint, box, ball, cylinder, rod, ring, wall, label } = b;
  const wood = paint('#b8936b'), cream = paint('#f4ecde'), dark = paint('#46535a');
  const green = paint('#73976a'), metal = paint('#a8b8ba', 0.45);
  const glass = new MeshStandardMaterial({
    color: '#b5dae0', transparent: true, opacity: 0.14, depthWrite: false, roughness: 0.15, side: DoubleSide,
  });
  b.floor(root, [[-7, -6], [7, -6], [7, 6], [-7, 6]], '#d7c6ad');
  const room = (id: string, x: number, z: number, width: number, depth: number, color: string): Group => {
    const group = new Group();
    group.name = `Apartment ${id}`;
    group.userData.room = id;
    box(group, paint(color), x, -0.003, z, width - 0.04, 0.008, depth - 0.04);
    label(group, text(`CRAZYFLIE_HOME.${id}`), x, 1.8, z, Math.min(1.7, width - 0.15));
    root.add(group);
    return group;
  };
  const master = room('MASTER', -4.8, -3.8, 4.4, 4.4, '#d4bea3');
  const child = room('CHILD', -4.8, 0.9, 4.4, 5, '#d3decf');
  const guest = room('GUEST', -0.4, -4.4, 4.4, 3.2, '#ddd1be');
  const bathroom = room('BATHROOM', 2.6, -4.4, 1.6, 3.2, '#c4d5d4');
  const kitchen = room('KITCHEN', 5.2, -3.75, 3.6, 4.5, '#d5d6c9');
  const living = room('LIVING', 0.3, 0.95, 5.8, 4.9, '#e3d3bd');
  const entry = room('ENTRY', 5.1, 0.95, 3.8, 4.9, '#d6c7ad');
  const balcony = room('BALCONY', 0, 4.7, 14, 2.6, '#acb69a');
  room('HALLWAY', 0.4, -2.15, 6, 1.3, '#e5d7c3');

  wall(root, [-6.95, -5.95], [6.95, -5.95], '#f0e5d3');
  wall(root, [-6.95, -5.95], [-6.95, 3.35], '#f0e5d3');
  wall(root, [6.95, -5.95], [6.95, -0.65], '#f0e5d3');
  wall(root, [6.95, 0.65], [6.95, 3.35], '#f0e5d3');
  wall(root, [-6.9, -1.6], [-2.6, -1.6], '#e8dccb');
  for (const [start, end] of [[-5.9, -2.8], [-1.6, -0.6], [0.6, 3.35]]) {
    wall(root, [-2.6, start], [-2.6, end], '#e8dccb');
  }
  wall(root, [1.8, -5.9], [1.8, -2.8], '#e8dccb');
  wall(root, [3.4, -5.9], [3.4, -2.8], '#e8dccb');
  for (const [start, end] of [[-2.6, -0.8], [0.4, 2.05], [3.15, 3.4]]) {
    wall(root, [start, -2.8], [end, -2.8], '#e8dccb');
  }
  wall(root, [4.5, -1.5], [6.9, -1.5], '#e8dccb');
  const doorway = (x: number, z: number, width: number, rotated = false): void => {
    const frame = new Group();
    frame.name = 'Open apartment doorway';
    frame.userData.clearWidth = width;
    frame.position.set(x, 0, z);
    if (rotated) frame.rotation.y = Math.PI / 2;
    for (const side of [-1, 1]) box(frame, wood, side * width / 2, 1.1, 0, 0.06, 2.2, 0.13);
    box(frame, wood, 0, 2.2, 0, width + 0.06, 0.07, 0.13);
    root.add(frame);
  };
  doorway(-2.6, -2.2, 1.2, true); doorway(-2.6, 0, 1.2, true);
  doorway(-0.2, -2.8, 1.2); doorway(2.6, -2.8, 1.1);
  doorway(3.95, -1.5, 1.1); doorway(6.95, 0, 1.3, true);

  const window = (x: number, z: number, width: number, rotated = false): void => {
    const group = new Group();
    group.name = 'Floor-to-ceiling window';
    group.position.set(x, 0, z);
    if (rotated) group.rotation.y = Math.PI / 2;
    box(group, glass, 0, 1.35, 0, width, 2.6, 0.025);
    for (const side of [-1, 0, 1]) box(group, dark, side * width / 2, 1.35, 0, 0.035, 2.65, 0.04);
    for (const y of [0.03, 2.67]) box(group, dark, 0, y, 0, width, 0.035, 0.04);
    root.add(group);
  };
  window(-6.95, -3.8, 2.9, true); window(-6.95, 1.5, 2.5, true);
  window(6.95, -4.2, 2.4, true);
  for (const [x, width] of [[-4.8, 4.2], [2, 2.4], [5.1, 3.5]]) window(x, 3.35, width);
  doorway(0, 3.35, 1.6);
  box(balcony, glass, 0, 0.58, 5.9, 13.8, 1.12, 0.025);
  box(balcony, metal, 0, 1.15, 5.9, 13.8, 0.04, 0.04);
  for (const x of [-6.9, 6.9]) {
    box(balcony, glass, x, 0.58, 4.65, 0.025, 1.12, 2.5);
    box(balcony, metal, x, 1.15, 4.65, 0.04, 0.04, 2.5);
  }

  const bed = (parent: Group, x: number, z: number, width: number, color: string): void => {
    const group = new Group();
    group.name = 'Apartment bed';
    group.userData.bed = true;
    box(group, wood, x, 0.23, z, width, 0.4, 2.15);
    box(group, cream, x, 0.49, z, width - 0.06, 0.22, 2.08);
    box(group, paint(color), x, 0.62, z + 0.25, width - 0.04, 0.06, 1.52);
    box(group, wood, x, 0.75, z - 1.12, width + 0.04, 1.12, 0.08);
    for (const side of [-1, 1]) box(group, cream, x + side * width * 0.23, 0.65, z - 0.68, width * 0.38, 0.14, 0.45);
    parent.add(group);
  };
  const cabinet = (parent: Group, x: number, z: number, width: number, height: number, depth: number): void => {
    box(parent, cream, x, height / 2, z, width, height, depth);
    for (const side of [-1, 1]) box(parent, wood, x + side * 0.06, height * 0.55, z + depth / 2 + 0.015, 0.025, 0.18, 0.025);
  };
  bed(master, -4.8, -4, 1.9, '#b8c5bc');
  cabinet(master, -3.2, -5.25, 0.75, 1.9, 1);
  for (const x of [-6.1, -3.5]) {
    cabinet(master, x, -4.5, 0.45, 0.5, 0.45);
    cylinder(master, wood, x, 0.74, -4.5, 0.015, 0.45);
    cylinder(master, paint('#d7b889'), x, 0.95, -4.5, 0.17, 0.22, 0.11);
  }
  bed(child, -5.5, 0.3, 1.3, '#a3c4d3');
  cabinet(child, -3.3, 2.5, 0.75, 1.5, 0.55);
  box(child, wood, -3.5, 0.73, 1.15, 1.35, 0.08, 0.65);
  for (const x of [-4, -3]) for (const z of [0.95, 1.35]) box(child, wood, x, 0.36, z, 0.06, 0.72, 0.06);
  box(child, paint('#9db6a4'), -4.5, 0.012, 2.1, 1.3, 0.02, 0.8);
  for (let i = 0; i < 7; i++) {
    box(child, paint(['#dba88b', '#a8bed0', '#dabd70'][i % 3]), -4.9 + i * 0.12, 0.13, 2 + i % 2 * 0.25, 0.15, 0.22, 0.15);
  }
  bed(guest, -0.8, -4.5, 1.65, '#d7c39f');
  cabinet(guest, 0.9, -5.3, 0.9, 1.8, 0.65);

  const sofa = new Group();
  sofa.name = 'Living room sofa';
  box(sofa, paint('#c5b39a'), 0, 0.32, 1.9, 2.7, 0.55, 0.85);
  box(sofa, paint('#b5aa91'), 0, 0.78, 2.25, 2.7, 0.65, 0.18);
  for (const x of [-1.3, 1.3]) box(sofa, paint('#b5aa91'), x, 0.6, 1.9, 0.18, 0.5, 0.85);
  for (const x of [-0.8, 0, 0.8]) box(sofa, cream, x, 0.64, 1.95, 0.65, 0.12, 0.55);
  living.add(sofa);
  box(living, wood, 0, 0.45, 0.9, 1.25, 0.08, 0.6);
  for (const x of [-0.48, 0.48]) box(living, dark, x, 0.22, 0.9, 0.06, 0.44, 0.45);
  box(living, wood, 2.8, 0.28, 1.3, 0.4, 0.5, 1.8);
  box(living, dark, 2.9, 1.25, 1.3, 0.06, 0.85, 1.5).name = 'Television';
  box(living, paint('#778e93'), 2.86, 1.25, 1.3, 0.015, 0.72, 1.35);
  cabinet(entry, 6.4, 1, 0.6, 1.1, 1.4);
  box(entry, wood, 4.8, 0.75, 1.8, 1.5, 0.08, 0.9);
  for (const x of [4.2, 5.4]) for (const z of [1.45, 2.15]) box(entry, wood, x, 0.36, z, 0.06, 0.72, 0.06);
  for (const x of [4.35, 5.25]) for (const z of [1, 2.6]) {
    box(entry, paint('#afbaa9'), x, 0.43, z, 0.43, 0.08, 0.43);
    box(entry, wood, x, 0.23, z, 0.08, 0.45, 0.08);
    box(entry, paint('#afbaa9'), x, 0.7, z < 1.5 ? z - 0.18 : z + 0.18, 0.43, 0.45, 0.06);
  }

  for (const x of [4, 4.8, 5.6, 6.4]) {
    cabinet(kitchen, x, -5.5, 0.76, 0.82, 0.65);
    box(kitchen, metal, x, 0.86, -5.5, 0.79, 0.06, 0.7);
  }
  for (const z of [-4.6, -3.8, -3]) {
    cabinet(kitchen, 6.5, z, 0.65, 0.82, 0.76);
    box(kitchen, metal, 6.5, 0.86, z, 0.7, 0.06, 0.79);
  }
  box(kitchen, paint('#809ea2'), 4, 0.9, -5.5, 0.48, 0.025, 0.42).name = 'Kitchen sink';
  rod(kitchen, metal, new Vector3(4, 0.9, -5.75), new Vector3(4, 1.18, -5.75), 0.025);
  rod(kitchen, metal, new Vector3(4, 1.18, -5.75), new Vector3(4, 1.18, -5.5), 0.025);
  for (const x of [5.3, 5.8]) ring(kitchen, dark, 0.15, 0.025, x, 0.91, -5.5).rotation.x = -Math.PI / 2;
  box(kitchen, metal, 5.55, 1.9, -5.6, 1, 0.16, 0.5).name = 'Kitchen extractor';
  const refrigerator = new Group();
  refrigerator.name = 'Refrigerator';
  cabinet(refrigerator, 3.95, -2.5, 0.8, 1.8, 0.8);
  box(refrigerator, metal, 3.95, 1.3, -2.09, 0.78, 0.025, 0.02);
  kitchen.add(refrigerator);

  ball(bathroom, cream, 2.6, 0.32, -5.25, 0.24, 0.27, 0.32).name = 'Toilet bowl';
  cylinder(bathroom, cream, 2.6, 0.13, -5.3, 0.16, 0.26);
  box(bathroom, cream, 2.6, 0.65, -5.55, 0.43, 0.6, 0.18);
  const seat = ring(bathroom, cream, 0.2, 0.035, 2.6, 0.55, -5.23);
  seat.rotation.x = -Math.PI / 2;
  seat.scale.y = 1.25;
  box(bathroom, cream, 2.55, 0.7, -4.4, 0.62, 0.1, 0.45).name = 'Bathroom basin';
  box(bathroom, metal, 2.55, 1.3, -4.62, 0.55, 0.7, 0.025);
  box(bathroom, cream, 2.6, 0.02, -3.4, 1.2, 0.04, 0.85).name = 'Shower tray';
  box(bathroom, glass, 2.05, 0.95, -3.4, 0.025, 1.9, 0.8);
  rod(bathroom, metal, new Vector3(3.1, 0.7, -3.4), new Vector3(3.1, 1.9, -3.4), 0.018);
  cylinder(bathroom, metal, 3, 1.9, -3.4, 0.1, 0.03);

  box(balcony, green, -1.8, 0.012, 4.75, 4, 0.02, 1.9).name = 'Sky garden lawn';
  for (const x of [-5.4, 5.4]) {
    box(balcony, wood, x, 0.25, 4.8, 2.3, 0.5, 1.25);
    box(balcony, paint('#846c50'), x, 0.52, 4.8, 2.15, 0.04, 1.1);
    for (let i = 0; i < 8; i++) {
      const xx = x - 0.9 + i * 0.26;
      cylinder(balcony, green, xx, 0.78, 4.7, 0.02, 0.5);
      ball(balcony, green, xx, 1, 4.7, 0.22, 0.3, 0.2);
      ball(balcony, paint(i % 2 ? '#dfb898' : '#cbb4ca'), xx, 1.2, 4.7, 0.1);
    }
  }
  for (const x of [1.2, 3.2]) {
    box(balcony, wood, x, 0.4, 4.9, 0.7, 0.08, 0.7);
    box(balcony, cream, x, 0.65, 5.18, 0.7, 0.55, 0.08);
    for (const side of [-1, 1]) box(balcony, wood, x + side * 0.25, 0.2, 4.9, 0.06, 0.4, 0.55);
  }
  cylinder(balcony, cream, 2.2, 0.5, 4.6, 0.32, 0.05);
  cylinder(balcony, wood, 2.2, 0.25, 4.6, 0.06, 0.5);
  b.pad(root);
  return root;
}

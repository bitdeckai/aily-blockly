import { CylinderGeometry, DoubleSide, Group, MeshStandardMaterial, TorusGeometry, Vector3 } from 'three';
import { ExplorationScene } from './crazyflie-exploration';
import { SceneBuilder } from './crazyflie-scene-builder';

export function buildMuseumArchitecture(root: Group, definition: ExplorationScene, b: SceneBuilder,
  text: (key: string) => string): void {
  const { box, ball, cylinder, ring, rod, wall, paint, label } = b;
  const architecture = new Group();
  architecture.name = `Architecture ${definition.id}`;
  root.add(architecture);
  b.floor(architecture, definition.boundary, definition.floor);
  const cream = paint('#f4e8d1'), frame = paint('#587578'), green = paint('#65946c');
  const glass = new MeshStandardMaterial({
    color: '#b7dce1', transparent: true, opacity: 0.18, depthWrite: false, roughness: 0.2, side: DoubleSide,
  });
  definition.boundary.forEach((point, i) => {
    wall(architecture, point, definition.boundary[(i + 1) % definition.boundary.length],
      definition.id === 'space' ? '#535974' : '#e5ddcb', 0.65);
  });
  const path = (from: readonly [number, number], to: readonly [number, number], width = 0.75): void => {
    wall(architecture, from, to, '#e8dfc9', 0.012, width).name = 'Visitor walkway';
  };
  const bench = (x: number, z: number, rotate = false): void => {
    const group = new Group();
    group.name = 'Visitor bench';
    group.position.set(x, 0, z);
    if (rotate) group.rotation.y = Math.PI / 2;
    box(group, paint('#a88866'), 0, 0.42, 0, 1.15, 0.1, 0.4);
    box(group, paint('#a88866'), 0, 0.65, 0.15, 1.15, 0.4, 0.05);
    for (const x of [-0.4, 0.4]) box(group, frame, x, 0.2, 0, 0.07, 0.4, 0.32);
    architecture.add(group);
  };
  const planter = (x: number, z: number, size = 1): void => {
    cylinder(architecture, paint('#d0b48b'), x, 0.2, z, size * 0.3, 0.4, size * 0.4);
    cylinder(architecture, paint('#765d42'), x, 0.65, z, 0.045, 0.95);
    for (let i = 0; i < 5; i++) {
      const a = i / 5 * Math.PI * 2;
      const leaf = ball(architecture, green, x + Math.cos(a) * size * 0.2, 1.05, z + Math.sin(a) * size * 0.2,
        size * 0.36, 0.12, size * 0.18);
      leaf.rotation.y = -a;
    }
  };
  const caseDisplay = (x: number, z: number, color: string): void => {
    const group = new Group();
    group.name = 'Collection cabinet';
    group.position.set(x, 0, z);
    box(group, cream, 0, 0.33, 0, 0.75, 0.66, 0.4);
    box(group, glass, 0, 0.95, 0, 0.73, 0.6, 0.38);
    for (const x of [-0.22, 0, 0.22]) {
      ball(group, paint(color), x, 0.78, 0, 0.08, 0.12, 0.08);
    }
    architecture.add(group);
  };
  const portal = (x: number, z: number, rotate = false): void => {
    const group = new Group();
    group.name = 'Open gallery portal';
    group.position.set(x, 0, z);
    if (rotate) group.rotation.y = Math.PI / 2;
    for (const x of [-1.05, 1.05]) box(group, frame, x, 1.15, 0, 0.12, 2.3, 0.14);
    box(group, cream, 0, 2.3, 0, 2.22, 0.12, 0.14);
    architecture.add(group);
  };
  label(architecture, text(definition.nameKey), 0, 3.2, -definition.size.depth / 2 + 0.4, 3.2);

  if (definition.id === 'animals') {
    const pond = cylinder(architecture, paint('#8ab4ac'), -1.6, 0.025, 0.8, 1, 0.04);
    pond.scale.set(1, 1, 1.25);
    pond.name = 'Oval courtyard pond';
    for (const radius of [1.4, 2.2]) {
      const walk = ring(architecture, cream, radius, 0.04, -1.6, 0.02, 0.8);
      walk.rotation.x = -Math.PI / 2;
      walk.scale.y = 1.22;
    }
    for (let i = 0; i < 11; i++) {
      const a = Math.PI * 0.12 + i / 10 * Math.PI * 1.55;
      const x = -1.6 + Math.cos(a) * 1.35, z = 0.8 + Math.sin(a) * 1.65;
      if (z < -0.5) continue;
      rod(architecture, cream, new Vector3(x, 0.1, z), new Vector3(x, 2.8, z), 0.025);
      for (const y of [0.8, 1.6, 2.4]) {
        const cell = ring(architecture, cream, 0.22, 0.022, x, y, z);
        cell.rotation.y = -a;
      }
    }
    wall(architecture, [-6.6, 0], [-4.3, 0], '#d0bfa4');
    wall(architecture, [2.4, -5.8], [2.4, -2.4], '#d0bfa4');
    wall(architecture, [2.6, 2.5], [6.8, 2.5], '#d0bfa4');
    portal(-4, 0); portal(2.4, -1.1, true); portal(1.3, 2.5);
    for (const [x, z] of [[-6.2, 1.3], [3.8, 4.7], [5.8, -1], [-3.6, 5]]) planter(x, z, 0.8);
    for (const [x, z] of [[-6.2, -1.5], [3.7, -5.2], [4.6, 4.6], [-3.4, -5.4]]) caseDisplay(x, z, '#d6bb84');
    bench(4.5, 0); bench(-3.3, 3.7);
  } else if (definition.id === 'botanical') {
    path([-7.2, 0], [7.2, 0], 1.2); path([0, -4.8], [0, 4.8], 1);
    for (const x of [-7.5, -5, -2.5, 0, 2.5, 5, 7.5]) {
      const rib = b.add(architecture, new TorusGeometry(3, 0.035, 6, 36, Math.PI), cream, x, 0, 0);
      rib.rotation.y = Math.PI / 2;
      rib.name = 'Glasshouse arch';
      if (x < 7.5 && Math.abs(x + 1.25) > 2.4) {
        for (const z of [-3, 3]) box(architecture, glass, x + 1.25, 1.15, z, 2.3, 2.3, 0.025);
      }
    }
    for (const z of [-4.7, 4.7]) {
      cylinder(architecture, paint('#8db6a4'), 0, 0.02, z, 0.6, 0.04);
      for (let i = 0; i < 5; i++) {
        const a = i * Math.PI * 2 / 5;
        const leaf = cylinder(architecture, green, Math.cos(a) * 0.35, 0.05, z + Math.sin(a) * 0.35, 0.15, 0.015);
        leaf.name = 'Waterlily';
      }
    }
    for (const [x, z] of [[-6.7, 2.5], [-4, 2.3], [-2.2, -2.5], [2, 2.4], [6.6, -2.3]]) planter(x, z, 1.1);
    for (const x of [-5.4, 3.2]) bench(x, 2.5);
    for (const x of [-5.6, -1.6, 2.8, 5.8]) {
      box(architecture, paint('#ad9976'), x, 0.13, -2.65, 1.2, 0.25, 0.65);
      for (let j = 0; j < 5; j++) ball(architecture, green, x - 0.45 + j * 0.22, 0.45, -2.65, 0.18, 0.25, 0.18);
    }
  } else if (definition.id === 'science') {
    path([-8.1, 0], [8, 0], 1.3);
    path([-4.4, 0], [-4.4, 5.1]); path([3.5, 0], [3.5, -5.1]);
    for (const x of [-7.8, -4, 0, 4, 7.8]) {
      for (const z of [-2.8, 2.8]) {
        if (x > 2.5 && z < 0 || x < -3.5 && z > 0) continue;
        box(architecture, frame, x, 1.35, z, 0.12, 2.7, 0.12);
      }
      box(architecture, cream, x, 2.72, 0, 0.1, 0.1, 5.7);
    }
    wall(architecture, [-3.5, 4], [-3.5, 5.7], '#9fb9be');
    wall(architecture, [2.5, -5.7], [2.5, -4.2], '#9fb9be');
    portal(-4.4, 2.8); portal(3.6, -2.8);
    for (const [x, z] of [[-1.3, -2.5], [1.3, 2.4], [7.9, -1.5], [-6, 5.2]]) caseDisplay(x, z, '#e0b56d');
    for (let i = 0; i < 5; i++) {
      const x = -1.8 + i * 0.85;
      const station = new Group();
      station.name = 'Hands-on experiment station';
      box(station, frame, x, 0.4, -2.4, 0.55, 0.8, 0.45);
      ball(station, paint(i % 2 ? '#6aa9b8' : '#dfb265'), x, 1.05, -2.4, 0.2);
      ring(station, cream, 0.25, 0.025, x, 1.05, -2.4).rotation.y = Math.PI / 2;
      architecture.add(station);
    }
    bench(0.5, 2.4); bench(7.5, -5.1);
  } else if (definition.id === 'space') {
    path([-8, 0], [8, 0], 1.2);
    for (const x of [-4.5, 4.5]) {
      path([x, -6.1], [x, 6.1], 0.9);
      portal(x, 0);
      for (const z of [-6.4, -2.2, 2.2, 6.4]) {
        box(architecture, cream, x < 0 ? -8.4 : 8.4, 1.4, z, 0.14, 2.8, 0.14);
      }
    }
    const aircraft = new Group();
    aircraft.name = 'Suspended aircraft';
    ball(aircraft, cream, 0, 2.8, 0, 1.25, 0.14, 0.16);
    box(aircraft, paint('#c5a16b'), 0, 2.8, 0, 0.5, 0.04, 2.6);
    box(aircraft, cream, -0.9, 2.83, 0, 0.35, 0.04, 0.9);
    box(aircraft, cream, -1, 3, 0, 0.25, 0.4, 0.04);
    for (const z of [-0.65, 0.65]) rod(aircraft, frame, new Vector3(0, 2.8, z), new Vector3(0, 3.7, z), 0.008);
    architecture.add(aircraft);
    for (const [x, z] of [[-7.5, -0.8], [7.5, 0.8], [-3.8, 6], [3.8, -6]]) caseDisplay(x, z, '#c2b9db');
    for (let i = 0; i < 6; i++) {
      cylinder(architecture, frame, -7.7 + i * 0.7, 0.4, 6, 0.12, 0.8);
      b.add(architecture, new CylinderGeometry(0, 0.12, 0.3, 12), cream, -7.7 + i * 0.7, 0.95, 6);
    }
    bench(-0.2, 2.1); bench(6.6, -0.8);
  } else {
    const tank = new Group();
    tank.name = 'Central Pacific tank';
    tank.position.set(-3, 0, 0);
    cylinder(tank, frame, 0, 0.08, 0, 1.85, 0.16);
    b.add(tank, new CylinderGeometry(1.75, 1.75, 2.2, 48, 1, true), glass, 0, 1.2, 0);
    cylinder(tank, paint('#76abae'), 0, 0.18, 0, 1.72, 0.06);
    for (const y of [0.16, 2.3]) ring(tank, cream, 1.77, 0.04, 0, y, 0).rotation.x = -Math.PI / 2;
    for (let i = 0; i < 15; i++) {
      const a = i * 2.4, radius = 0.6 + i % 3 * 0.3;
      const fish = new Group();
      fish.name = 'Reef fish';
      fish.position.set(Math.cos(a) * radius, 0.6 + i % 4 * 0.3, Math.sin(a) * radius);
      fish.rotation.y = -a;
      ball(fish, paint(i % 2 ? '#e5c071' : '#70aabf'), 0, 0, 0, 0.17, 0.08, 0.06);
      box(fish, cream, -0.17, 0, 0, 0.04, 0.15, 0.02).rotation.z = 0.5;
      tank.add(fish);
    }
    architecture.add(tank);
    const promenade = ring(architecture, cream, 2.65, 0.055, -3, 0.02, 0);
    promenade.rotation.x = -Math.PI / 2;
    const tunnel = new Group();
    tunnel.name = 'Walk-through aquarium tunnel';
    const canopy = b.add(tunnel, new CylinderGeometry(1.05, 1.05, 3.3, 36, 1, true, 0, Math.PI),
      glass, 2.65, 0.1, 0);
    canopy.rotation.z = Math.PI / 2;
    for (let i = 0; i < 7; i++) {
      const arch = b.add(tunnel, new TorusGeometry(1.05, 0.035, 6, 32, Math.PI), frame, 1 + i * 0.55, 0.1, 0);
      arch.rotation.y = Math.PI / 2;
    }
    for (const z of [-1.4, 1.4]) {
      box(tunnel, paint('#86b8b8'), 2.65, 0.08, z, 3.5, 0.16, 0.45);
      for (let i = 0; i < 5; i++) {
        ball(tunnel, paint(i % 2 ? '#dfbc72' : '#76b4c5'), 1.3 + i * 0.65, 0.5 + i % 2 * 0.3, z, 0.18, 0.09, 0.05);
      }
    }
    path([0.8, 0], [4.5, 0], 1);
    architecture.add(tunnel);
    wall(architecture, [3, -5.6], [3, -3.1], '#86b4b5');
    wall(architecture, [3.1, 4.7], [3.1, 5.6], '#86b4b5');
    for (const [x, z] of [[-7.2, -1.8], [-7.2, 1.8], [6.9, 0.1]]) caseDisplay(x, z, '#a3c9c4');
    bench(1, 5.3); bench(-6.9, 2.9, true);
  }
}

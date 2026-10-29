import {
  BufferGeometry, Color, ConeGeometry, CylinderGeometry, DoubleSide, Group,
  Float32BufferAttribute, Line, LineDashedMaterial, Material, Mesh, MeshBasicMaterial, MeshStandardMaterial, Object3D, RingGeometry,
  SphereGeometry, Sprite, Texture, TorusGeometry, Vector3,
} from 'three';
import {
  ExplorationPoint, ExplorationProgress, ExplorationScene, EXPLORATION_RADIUS_M, explorationPointPosition,
} from './crazyflie-exploration';
import { createSceneBuilder } from './crazyflie-scene-builder';
import { buildMuseumArchitecture } from './crazyflie-museum-architecture';

export function createExplorationScene(definition: ExplorationScene, text: (key: string) => string): Group {
  const root = new Group();
  root.name = `Exploration ${definition.id}`;
  root.userData.exploration = true;
  const builder = createSceneBuilder(definition.accent);
  const { paint, add, ball, box, cylinder, rod, ring, label } = builder;
  const cream = paint('#f4e8d1'), dark = paint('#334652'), gold = paint('#d7aa61', 0.25);
  const accent = paint(definition.accent), green = paint('#679878');
  buildMuseumArchitecture(root, definition, builder, text);
  builder.pad(root);

  const flower = (parent: Group, x: number, z: number, color: string, height = 0.65): void => {
    cylinder(parent, green, x, height / 2, z, 0.02, height);
    const leaf = ball(parent, green, x + 0.1, height * 0.45, z, 0.15, 0.05, 0.07);
    leaf.rotation.z = 0.5;
    for (let j = 0; j < 7; j++) {
      const a = j / 7 * Math.PI * 2;
      ball(parent, paint(color), x + Math.cos(a) * 0.14, height + Math.sin(a) * 0.14, z, 0.11, 0.14, 0.045);
    }
    ball(parent, gold, x, height, z - 0.035, 0.09, 0.09, 0.05);
  };
  const planet = (parent: Group, x: number, y: number, z: number, radius: number, color: string, hasRing = false): void => {
    ball(parent, paint(color), x, y, z, radius);
    if (hasRing) {
      const orbit = ring(parent, gold, radius * 1.65, radius * 0.12, x, y, z);
      orbit.rotation.set(1.1, 0.2, 0.2);
    }
  };
  const solarPanel = (parent: Group, x: number, y: number, z: number, width: number): void => {
    const panel = new Group();
    panel.position.set(x, y, z);
    panel.rotation.x = -0.35;
    box(panel, cream, 0, 0, 0, width + 0.04, 0.04, 0.45);
    box(panel, paint('#365b85', 0.22), 0, 0.025, 0, width, 0.02, 0.42);
    for (let i = 1; i < 4; i++) box(panel, paint('#83b7ca'), -width / 2 + i * width / 4, 0.038, 0, 0.008, 0.004, 0.42);
    box(panel, paint('#83b7ca'), 0, 0.038, 0, width, 0.004, 0.008);
    parent.add(panel);
  };

  const makeAnimal = (exhibit: Group, index: number): void => {
    const bone = paint('#ead9ac');
    if (index === 0) {
      const spine = new Group();
      spine.rotation.z = -0.12;
      rod(spine, bone, new Vector3(-0.65, 0.8, 0), new Vector3(0.45, 0.85, 0), 0.045);
      for (let j = 0; j < 7; j++) {
        const rib = ring(spine, bone, 0.2 - Math.abs(j - 3) * 0.022, 0.018, -0.38 + j * 0.11, 0.74, 0);
        rib.rotation.y = Math.PI / 2;
      }
      ball(spine, bone, 0.57, 0.94, 0, 0.24, 0.17, 0.12);
      box(spine, dark, 0.68, 0.95, -0.11, 0.05, 0.04, 0.025);
      rod(spine, bone, new Vector3(-0.55, 0.79, 0), new Vector3(-0.87, 0.61, 0), 0.03);
      for (const z of [-0.12, 0.12]) {
        rod(spine, bone, new Vector3(-0.2, 0.72, z), new Vector3(-0.32, 0.22, z), 0.035);
        rod(spine, bone, new Vector3(-0.32, 0.22, z), new Vector3(-0.06, 0.17, z), 0.025);
      }
      for (const x of [-0.4, 0.35]) cylinder(exhibit, dark, x, 0.4, 0, 0.018, 0.6);
      exhibit.add(spine);
    } else if (index === 1) {
      const fur = paint('#e1b466');
      ball(exhibit, fur, 0, 0.65, 0, 0.42, 0.22, 0.21);
      for (const x of [-0.25, 0.25]) for (const z of [-0.12, 0.12]) cylinder(exhibit, fur, x, 0.34, z, 0.045, 0.58);
      const neck = cylinder(exhibit, fur, 0.3, 1.05, 0, 0.085, 0.9);
      neck.rotation.z = -0.2;
      ball(exhibit, fur, 0.39, 1.52, 0, 0.18, 0.11, 0.11);
      for (const z of [-0.08, 0.08]) {
        cylinder(exhibit, gold, 0.35, 1.65, z, 0.018, 0.15);
        ball(exhibit, dark, 0.43, 1.56, z * 1.35, 0.018);
        ball(exhibit, fur, 0.27, 1.61, z * 1.6, 0.07, 0.035, 0.04);
      }
      for (let j = 0; j < 5; j++) {
        for (const z of [-0.19, 0.19]) ball(exhibit, paint('#9b713b'), -0.25 + j * 0.12, 0.68, z, 0.045, 0.065, 0.02);
        ball(exhibit, paint('#9b713b'), 0.3 + j * 0.018, 0.86 + j * 0.12, -0.08, 0.04, 0.05, 0.02);
      }
    } else if (index === 2) {
      cylinder(exhibit, paint('#b6d8dd'), 0, 0.12, 0, 0.5, 0.15);
      for (const x of [-0.23, 0.23]) {
        ball(exhibit, dark, x, 0.62, 0, 0.18, 0.33, 0.19);
        ball(exhibit, cream, x, 0.61, -0.12, 0.13, 0.23, 0.09);
        ball(exhibit, dark, x, 0.97, 0, 0.17);
        ball(exhibit, cream, x, 0.97, -0.12, 0.12, 0.09, 0.06);
        ball(exhibit, dark, x - 0.05, 0.99, -0.174, 0.014);
        ball(exhibit, dark, x + 0.05, 0.99, -0.174, 0.014);
        const beak = add(exhibit, new ConeGeometry(0.055, 0.14, 4), gold, x, 0.92, -0.23);
        beak.rotation.x = -Math.PI / 2;
        for (const side of [-1, 1]) {
          ball(exhibit, gold, x + side * 0.09, 0.25, -0.1, 0.075, 0.025, 0.12);
          const wing = ball(exhibit, dark, x + side * 0.17, 0.64, 0, 0.055, 0.22, 0.09);
          wing.rotation.z = side * 0.25;
        }
      }
    } else if (index === 3) {
      flower(exhibit, -0.24, 0.1, '#d994a2', 0.5);
      flower(exhibit, 0.3, 0.05, '#e8b857', 0.4);
      ball(exhibit, dark, 0, 0.92, -0.08, 0.045, 0.26, 0.05);
      for (const side of [-1, 1]) {
        const upper = ball(exhibit, paint('#69a8bc'), side * 0.23, 1.03, -0.07, 0.26, 0.3, 0.04);
        upper.rotation.z = side * -0.35;
        ball(exhibit, paint('#dc9c68'), side * 0.18, 0.75, -0.07, 0.2, 0.18, 0.04);
        ball(exhibit, cream, side * 0.26, 1.07, -0.11, 0.11, 0.15, 0.018);
        rod(exhibit, dark, new Vector3(0, 1.13, -0.08), new Vector3(side * 0.1, 1.31, -0.08), 0.009);
      }
    } else {
      cylinder(exhibit, paint('#8ebfc8'), 0, 0.12, 0, 0.56, 0.14);
      const whale = new Group();
      whale.rotation.y = -0.4;
      ball(whale, paint('#6196aa'), 0, 0.7, 0, 0.63, 0.25, 0.26);
      ball(whale, paint('#d5e0d7'), 0.08, 0.59, -0.05, 0.46, 0.09, 0.22);
      for (const side of [-1, 1]) {
        const tail = ball(whale, paint('#6196aa'), -0.65, 0.79, side * 0.16, 0.2, 0.04, 0.22);
        tail.rotation.z = 0.2;
        ball(whale, paint('#6196aa'), 0.04, 0.6, side * 0.29, 0.19, 0.04, 0.18);
        ball(whale, dark, 0.4, 0.75, side * 0.21, 0.025);
      }
      for (let j = 0; j < 3; j++) ball(whale, paint('#bedde0'), 0.2 + j * 0.06, 1.08 + j * 0.09, 0, 0.04);
      exhibit.add(whale);
    }
  };
  const makeBotanical = (exhibit: Group, index: number): void => {
    const bark = paint('#947253');
    if (index === 0) {
      cylinder(exhibit, bark, 0, 0.6, 0, 0.15, 1.1, 0.09);
      for (let j = 0; j < 5; j++) {
        const a = j / 5 * Math.PI * 2;
        rod(exhibit, bark, new Vector3(0, 0.7, 0), new Vector3(Math.cos(a) * 0.38, 1.15, Math.sin(a) * 0.38), 0.045);
        ball(exhibit, paint(j % 2 ? '#7da569' : '#5d8d6a'), Math.cos(a) * 0.35, 1.3, Math.sin(a) * 0.35, 0.38, 0.44, 0.38);
      }
      ball(exhibit, green, 0, 1.6, 0, 0.4);
      for (const x of [-0.35, 0.25]) ball(exhibit, bark, x, 0.15, 0, 0.2, 0.04, 0.12);
    } else if (index === 1) {
      flower(exhibit, -0.32, 0, '#d893a7', 0.65);
      flower(exhibit, 0, 0.1, '#e4b85e', 0.95);
      flower(exhibit, 0.33, -0.04, '#a392c3', 0.75);
      cylinder(exhibit, paint('#b67f60'), 0, 0.17, 0, 0.44, 0.3, 0.5);
    } else if (index === 2) {
      cylinder(exhibit, paint('#d5b78d'), 0, 0.16, 0, 0.5, 0.18);
      for (const [x, h, radius] of [[0, 1.1, 0.17], [-0.34, 0.6, 0.13], [0.34, 0.75, 0.12]]) {
        cylinder(exhibit, green, x, 0.22 + h / 2, 0, radius, h);
        ball(exhibit, green, x, 0.22 + h, 0, radius);
        for (let j = 0; j < 6; j++) {
          const a = j / 6 * Math.PI * 2;
          cylinder(exhibit, paint('#a5bd87'), x + Math.cos(a) * radius, 0.22 + h / 2, Math.sin(a) * radius, 0.009, h * 0.9);
        }
      }
      rod(exhibit, green, new Vector3(0, 0.6, 0), new Vector3(-0.34, 0.6, 0), 0.09);
      rod(exhibit, green, new Vector3(0, 0.75, 0), new Vector3(0.34, 0.75, 0), 0.08);
      flower(exhibit, 0.01, 0, '#d697a2', 1.43);
    } else if (index === 3) {
      for (const [x, z, scale] of [[0, 0.1, 1], [-0.37, -0.15, 0.6], [0.36, -0.18, 0.5]]) {
        cylinder(exhibit, cream, x, 0.45 * scale, z, 0.09 * scale, 0.8 * scale);
        const cap = ball(exhibit, paint('#be7663'), x, 0.82 * scale, z, 0.38 * scale, 0.19 * scale, 0.38 * scale);
        cap.name = 'Mushroom cap';
        for (let j = 0; j < 7; j++) {
          const a = j / 7 * Math.PI * 2;
          ball(exhibit, cream, x + Math.cos(a) * 0.23 * scale, 0.94 * scale, z + Math.sin(a) * 0.23 * scale, 0.038 * scale, 0.018 * scale);
        }
      }
    } else {
      ball(exhibit, bark, -0.13, 0.3, 0, 0.3, 0.2, 0.26);
      ball(exhibit, paint('#c5a474'), 0.19, 0.3, 0, 0.24, 0.18, 0.23);
      rod(exhibit, green, new Vector3(0, 0.26, 0), new Vector3(0, 1.12, 0), 0.035);
      for (const side of [-1, 1]) {
        const leaf = ball(exhibit, green, side * 0.2, 0.96, 0, 0.28, 0.075, 0.12);
        leaf.rotation.z = side * 0.5;
      }
      for (let j = 0; j < 4; j++) rod(exhibit, cream, new Vector3(0, 0.22, 0),
        new Vector3(-0.28 + j * 0.18, 0.08, -0.1), 0.012);
    }
  };
  const makeScience = (exhibit: Group, index: number): void => {
    if (index === 0) {
      box(exhibit, accent, 0, 0.75, 0, 0.48, 0.5, 0.28);
      box(exhibit, cream, 0, 1.16, 0, 0.5, 0.3, 0.32);
      box(exhibit, dark, 0, 1.18, -0.17, 0.36, 0.13, 0.025);
      for (const side of [-1, 1]) {
        ball(exhibit, paint('#8acac3'), side * 0.09, 1.19, -0.19, 0.035);
        ball(exhibit, gold, side * 0.3, 0.88, 0, 0.09);
        rod(exhibit, accent, new Vector3(side * 0.3, 0.88, 0), new Vector3(side * 0.42, 0.59, 0), 0.055);
        cylinder(exhibit, dark, side * 0.14, 0.34, 0, 0.07, 0.35);
        box(exhibit, cream, side * 0.14, 0.17, -0.03, 0.2, 0.12, 0.3);
      }
      cylinder(exhibit, gold, 0, 1.43, 0, 0.015, 0.18);
      ball(exhibit, paint('#d88f79'), 0, 1.53, 0, 0.05);
      for (let j = 0; j < 3; j++) box(exhibit, gold, -0.1 + j * 0.1, 0.77, -0.15, 0.04, 0.1, 0.02);
    } else if (index === 1) {
      planet(exhibit, 0, 0.7, 0, 0.21, '#e6b258');
      for (let j = 0; j < 4; j++) {
        const radius = 0.3 + j * 0.12;
        const orbit = ring(exhibit, gold, radius, 0.008, 0, 0.7, 0);
        orbit.rotation.x = -Math.PI / 2 + 0.3;
        const a = j * 1.9;
        planet(exhibit, Math.cos(a) * radius, 0.7, Math.sin(a) * radius, 0.045 + j * 0.012,
          ['#c19c85', '#87b2c2', '#c78165', '#aaa0c5'][j], j === 3);
      }
      cylinder(exhibit, dark, 0, 0.3, 0, 0.02, 0.4);
    } else if (index === 2) {
      cylinder(exhibit, cream, 0, 0.8, 0, 0.18, 0.8);
      add(exhibit, new ConeGeometry(0.18, 0.38, 24), paint('#c98573'), 0, 1.39, 0);
      const window = ring(exhibit, gold, 0.085, 0.018, 0, 0.98, -0.18);
      window.name = 'Rocket porthole';
      ball(exhibit, paint('#74a8b8'), 0, 0.98, -0.18, 0.07, 0.07, 0.02);
      for (const side of [-1, 1]) {
        const fin = box(exhibit, paint('#c98573'), side * 0.21, 0.43, 0, 0.16, 0.34, 0.09);
        fin.rotation.z = side * -0.3;
      }
      cylinder(exhibit, dark, 0, 0.33, 0, 0.13, 0.13, 0.1);
      add(exhibit, new ConeGeometry(0.1, 0.25, 16), gold, 0, 0.16, 0).rotation.z = Math.PI;
    } else if (index === 3) {
      for (const [x, y, radius, color] of [[-0.24, 0.85, 0.31, '#d7aa61'], [0.3, 0.61, 0.23, '#74aeb6'], [0.23, 1.18, 0.2, '#c58a7d']] as const) {
        const gear = new Group();
        gear.position.set(x, y, 0);
        ring(gear, paint(color, 0.25), radius * 0.74, radius * 0.23, 0, 0, 0);
        cylinder(gear, dark, 0, 0, 0, radius * 0.17, 0.12).rotation.x = Math.PI / 2;
        for (let j = 0; j < 12; j++) {
          const a = j / 12 * Math.PI * 2;
          const tooth = box(gear, paint(color, 0.25), Math.cos(a) * radius, Math.sin(a) * radius, 0, radius * 0.3, radius * 0.22, 0.1);
          tooth.rotation.z = a;
        }
        for (let j = 0; j < 3; j++) {
          const spoke = box(gear, paint(color, 0.25), 0, 0, 0, radius * 1.3, 0.045, 0.08);
          spoke.rotation.z = j * Math.PI / 3;
        }
        exhibit.add(gear);
      }
      for (const x of [-0.24, 0.3]) cylinder(exhibit, dark, x, 0.38, 0.1, 0.02, 0.65);
    } else {
      cylinder(exhibit, cream, -0.25, 0.6, 0, 0.035, 1.05);
      ball(exhibit, gold, -0.25, 1.18, -0.02, 0.08);
      for (let j = 0; j < 3; j++) {
        const a = j / 3 * Math.PI * 2;
        const blade = box(exhibit, cream, -0.25 + Math.sin(a) * 0.23, 1.18 + Math.cos(a) * 0.23, -0.03, 0.07, 0.42, 0.025);
        blade.rotation.z = -a;
      }
      solarPanel(exhibit, 0.25, 0.42, -0.12, 0.55);
      cylinder(exhibit, dark, 0.25, 0.24, 0, 0.025, 0.3);
      box(exhibit, green, 0.3, 0.25, 0.3, 0.2, 0.3, 0.14);
      box(exhibit, gold, 0.3, 0.42, 0.3, 0.09, 0.03, 0.08);
    }
  };
  const makeSpace = (exhibit: Group, index: number): void => {
    if (index === 0) {
      add(exhibit, new SphereGeometry(0.48, 24, 12, 0, Math.PI * 2, 0, Math.PI / 2), cream, 0, 0.16, 0);
      cylinder(exhibit, dark, 0, 0.13, 0, 0.5, 0.13);
      box(exhibit, accent, 0, 0.25, -0.44, 0.2, 0.22, 0.1);
      for (const side of [-1, 1]) ball(exhibit, paint('#7eb0bf'), side * 0.24, 0.31, -0.32, 0.09, 0.07, 0.02);
      cylinder(exhibit, gold, 0.44, 0.65, 0, 0.015, 1.2);
      box(exhibit, accent, 0.58, 1.15, 0, 0.27, 0.18, 0.02);
    } else if (index === 1) {
      const hub = cylinder(exhibit, cream, 0, 0.86, 0, 0.18, 0.7);
      hub.rotation.z = Math.PI / 2;
      ball(exhibit, dark, 0.39, 0.86, 0, 0.18, 0.13, 0.18);
      for (const side of [-1, 1]) {
        rod(exhibit, gold, new Vector3(0, 0.85, 0), new Vector3(0, 0.85, side * 0.56), 0.025);
        solarPanel(exhibit, 0, 0.86, side * 0.5, 0.65);
      }
      const halo = ring(exhibit, accent, 0.34, 0.025, 0, 0.86, 0);
      halo.rotation.y = Math.PI / 2;
      cylinder(exhibit, dark, 0, 0.42, 0, 0.02, 0.55);
    } else if (index === 2) {
      box(exhibit, gold, 0, 0.78, 0, 0.3, 0.35, 0.28);
      for (const side of [-1, 1]) solarPanel(exhibit, side * 0.43, 0.78, 0, 0.5);
      const dish = add(exhibit, new SphereGeometry(0.22, 20, 10, 0, Math.PI * 2, 0, Math.PI / 2), cream, 0, 1.03, 0);
      dish.rotation.z = -0.45;
      rod(exhibit, dark, new Vector3(0, 1.03, 0), new Vector3(-0.12, 1.33, 0), 0.012);
      cylinder(exhibit, dark, 0, 0.38, 0, 0.02, 0.55);
    } else if (index === 3) {
      box(exhibit, cream, 0, 0.46, 0, 0.6, 0.22, 0.44);
      for (const x of [-0.24, 0, 0.24]) for (const z of [-0.28, 0.28]) {
        const wheel = cylinder(exhibit, dark, x, 0.25, z, 0.13, 0.08);
        wheel.rotation.x = Math.PI / 2;
        const hub = cylinder(exhibit, gold, x, 0.25, z * 1.15, 0.06, 0.015);
        hub.rotation.x = Math.PI / 2;
      }
      cylinder(exhibit, dark, 0.15, 0.86, 0, 0.025, 0.6);
      box(exhibit, accent, 0.15, 1.13, 0, 0.24, 0.14, 0.16);
      for (const z of [-0.09, 0.09]) ball(exhibit, dark, 0.28, 1.13, z, 0.04);
      solarPanel(exhibit, -0.14, 0.61, 0, 0.32);
    } else {
      planet(exhibit, 0, 0.85, 0, 0.38, '#bda483', true);
      cylinder(exhibit, dark, 0, 0.36, 0, 0.025, 0.45);
      const orbit = ring(exhibit, paint('#b2a7d1'), 0.68, 0.009, 0, 0.85, 0);
      orbit.rotation.x = 1.3;
      planet(exhibit, 0.61, 1.04, 0, 0.075, '#c7ccd6');
    }
  };
  const makeOcean = (exhibit: Group, index: number): void => {
    const coral = paint('#ce8e7c'), seaGreen = paint('#729d88');
    if (index === 0) {
      for (let j = 0; j < 5; j++) {
        const x = -0.4 + j * 0.2;
        const h = 0.5 + (j % 3) * 0.18;
        const material = j % 2 ? coral : paint('#b7a0bd');
        cylinder(exhibit, material, x, h / 2 + 0.1, 0, 0.045, h);
        ball(exhibit, material, x, h + 0.1, 0, 0.055);
        for (const side of [-1, 1]) {
          rod(exhibit, material, new Vector3(x, h * 0.6, 0), new Vector3(x + side * 0.12, h * 0.85, 0.08), 0.025);
          ball(exhibit, material, x + side * 0.12, h * 0.85, 0.08, 0.035);
        }
      }
    } else if (index === 1) {
      ball(exhibit, seaGreen, 0, 0.62, 0, 0.42, 0.19, 0.33);
      ball(exhibit, paint('#a7bb85'), 0.46, 0.6, 0, 0.15, 0.1, 0.1);
      for (const side of [-1, 1]) {
        for (const x of [-0.25, 0.25]) {
          const fin = ball(exhibit, paint('#a7bb85'), x, 0.54, side * 0.33, 0.18, 0.035, 0.18);
          fin.rotation.y = side * 0.6;
        }
        ball(exhibit, dark, 0.51, 0.64, side * 0.08, 0.018);
      }
      for (let j = 0; j < 5; j++) ball(exhibit, paint('#496f63'), -0.25 + j * 0.12, 0.78, 0, 0.075, 0.025, 0.16);
    } else if (index === 2) {
      for (const [x, z, size] of [[0, 0, 1], [-0.38, 0.1, 0.6], [0.35, 0.15, 0.55]]) {
        const material = paint('#b9a2c2');
        add(exhibit, new SphereGeometry(size * 0.3, 24, 12, 0, Math.PI * 2, 0, Math.PI / 2), material, x, size * 1.05 + 0.15, z);
        for (let j = 0; j < 8; j++) {
          const a = j / 8 * Math.PI * 2;
          rod(exhibit, material, new Vector3(x + Math.cos(a) * size * 0.2, size * 1.05 + 0.15, z + Math.sin(a) * size * 0.2),
            new Vector3(x + Math.cos(a + 0.3) * size * 0.23, 0.25, z + Math.sin(a + 0.3) * size * 0.23), size * 0.012);
        }
      }
    } else if (index === 3) {
      const wood = paint('#927658');
      ball(exhibit, wood, 0, 0.3, 0, 0.65, 0.18, 0.26);
      box(exhibit, paint('#c1a17c'), 0, 0.4, 0, 0.95, 0.04, 0.38);
      cylinder(exhibit, wood, 0.08, 0.87, 0, 0.025, 0.95);
      const sail = box(exhibit, cream, -0.08, 1, 0, 0.4, 0.48, 0.025);
      sail.rotation.z = 0.15;
      for (const x of [-0.35, -0.1, 0.15, 0.4]) ball(exhibit, dark, x, 0.32, -0.24, 0.045, 0.045, 0.015);
      for (const x of [-0.45, 0.4]) rod(exhibit, seaGreen, new Vector3(x, 0.05, 0.2), new Vector3(x + 0.1, 0.5, 0.2), 0.025);
    } else {
      const yellow = paint('#d9b866');
      ball(exhibit, yellow, 0, 0.63, 0, 0.57, 0.25, 0.25);
      for (const x of [-0.25, 0, 0.25]) {
        const porthole = ring(exhibit, dark, 0.08, 0.018, x, 0.66, -0.235);
        porthole.name = 'Submarine porthole';
        ball(exhibit, paint('#8fc2ce'), x, 0.66, -0.24, 0.06, 0.06, 0.018);
      }
      cylinder(exhibit, yellow, 0, 0.94, 0, 0.13, 0.22);
      rod(exhibit, dark, new Vector3(0, 1.05, 0), new Vector3(0, 1.23, 0), 0.025);
      rod(exhibit, dark, new Vector3(0, 1.23, 0), new Vector3(0.12, 1.23, 0), 0.025);
      box(exhibit, yellow, -0.56, 0.62, 0, 0.1, 0.4, 0.06);
      box(exhibit, yellow, -0.56, 0.62, 0, 0.1, 0.06, 0.5);
    }
    for (let j = 0; j < 3; j++) {
      const blade = ball(exhibit, seaGreen, -0.47 + j * 0.12, 0.26 + j * 0.08, 0.32, 0.04, 0.25, 0.035);
      blade.rotation.z = -0.25 + j * 0.25;
    }
  };

  definition.points.forEach((point, index) => {
    const target = explorationPointPosition(point);
    const exhibit = new Group();
    exhibit.name = `Exhibit ${definition.stations[index]}`;
    exhibit.userData.exhibitId = point.id;
    exhibit.position.set(point.exhibit.x, 0, point.exhibit.z);
    cylinder(exhibit, dark, 0, 0.04, 0, 0.66, 0.08);
    cylinder(exhibit, definition.id === 'space' ? paint('#a6a6af') : cream, 0, 0.1, 0, 0.62, 0.06);
    if (definition.id === 'animals') makeAnimal(exhibit, index);
    else if (definition.id === 'botanical') makeBotanical(exhibit, index);
    else if (definition.id === 'science') makeScience(exhibit, index);
    else if (definition.id === 'space') makeSpace(exhibit, index);
    else makeOcean(exhibit, index);
    for (const [companionIndex, position] of point.companions.entries()) {
      const collection = exhibit.clone(true);
      collection.userData = { collection: true };
      collection.name = `Collection ${definition.stations[index]}`;
      collection.scale.setScalar(0.4);
      collection.position.set(position.x, 0, position.z);
      collection.rotation.y = companionIndex ? 0.3 : -0.3;
      root.add(collection);
    }
    label(exhibit, text(point.nameKey), 0, 1.95, 0, 1.2);
    root.add(exhibit);

    const checkpoint = new Group();
    checkpoint.name = `Checkpoint ${point.id}`;
    checkpoint.userData.checkpointId = point.id;
    checkpoint.position.set(target.x, target.y, target.z);
    const markerMaterial = new MeshStandardMaterial({ color: '#e8b85d', roughness: 0.65, metalness: 0.1 });
    const halo = ring(checkpoint, markerMaterial, EXPLORATION_RADIUS_M, 0.022, 0, 0, 0);
    halo.name = 'Checkpoint halo';
    halo.rotation.x = -Math.PI / 2;
    const secondHalo = ring(checkpoint, markerMaterial, EXPLORATION_RADIUS_M * 0.92, 0.009, 0, 0.045, 0);
    secondHalo.rotation.x = -Math.PI / 2;
    const selection = ring(checkpoint, paint('#83c6d4'), EXPLORATION_RADIUS_M + 0.07, 0.015, 0, 0.01, 0);
    selection.name = 'Checkpoint selection';
    selection.rotation.x = -Math.PI / 2;
    selection.visible = false;
    const stem = new Mesh(new CylinderGeometry(0.008, 0.008, target.y, 8),
      new MeshBasicMaterial({ color: definition.accent, transparent: true, opacity: 0.35, depthWrite: false }));
    stem.position.y = -target.y / 2;
    checkpoint.add(stem);
    const footprint = new Mesh(new RingGeometry(0.27, 0.32, 32),
      new MeshBasicMaterial({ color: '#506d71', side: DoubleSide, transparent: true, opacity: 0.35, depthWrite: false }));
    footprint.rotation.x = -Math.PI / 2;
    footprint.position.y = -target.y + 0.014;
    checkpoint.add(footprint);
    label(checkpoint, String(point.id), 0, 0.32, 0, 0.24, true);
    root.add(checkpoint);
  });
  const guideGeometry = new BufferGeometry();
  guideGeometry.setAttribute('position', new Float32BufferAttribute([0, 0, 0, 0, 0, 0], 3));
  guideGeometry.setAttribute('lineDistance', new Float32BufferAttribute([0, 0], 1));
  const guide = new Line(guideGeometry, new LineDashedMaterial({
    color: '#83c6d4', dashSize: 0.08, gapSize: 0.05, transparent: true, opacity: 0.85, depthWrite: false,
  }));
  guide.name = 'Checkpoint guidance';
  guide.visible = false;
  root.add(guide);
  return root;
}

export function updateExplorationMarkers(
  root: Group, progress: ExplorationProgress, enabled: boolean, selectedId: number | null = null,
): void {
  for (const child of root.children) {
    const id: unknown = child.userData.checkpointId;
    if (typeof id !== 'number') continue;
    child.visible = enabled;
    const selection = child.getObjectByName('Checkpoint selection');
    if (selection) selection.visible = enabled && id === selectedId;
    const halo = child.getObjectByName('Checkpoint halo');
    if (!(halo instanceof Mesh) || !(halo.material instanceof MeshStandardMaterial)) continue;
    const visited = progress.visited.includes(id);
    halo.material.color.copy(new Color(visited ? '#65b995' : progress.dwelling === id ? '#f5d992' : '#e8b85d'));
    halo.material.emissive.set(visited ? '#16372b' : '#000000');
  }
}

export function updateExplorationGuide(
  root: Group, position: { x: number; y: number; z: number }, point: ExplorationPoint | undefined, enabled: boolean,
): void {
  const guide = root.getObjectByName('Checkpoint guidance');
  if (!(guide instanceof Line)) throw new Error('Exploration scene is missing its guide line');
  guide.visible = enabled && point !== undefined;
  if (!guide.visible || !point) return;
  const target = explorationPointPosition(point);
  const positions = guide.geometry.getAttribute('position');
  const distances = guide.geometry.getAttribute('lineDistance');
  positions.setXYZ(0, position.x, position.y, position.z);
  positions.setXYZ(1, target.x, target.y, target.z);
  distances.setX(1, Math.hypot(target.x - position.x, target.y - position.y, target.z - position.z));
  positions.needsUpdate = true;
  distances.needsUpdate = true;
  guide.geometry.computeBoundingSphere();
}

export function disposeExplorationScene(root: Object3D): void {
  const geometries = new Set<BufferGeometry>();
  const materials = new Set<Material>();
  const textures = new Set<Texture>();
  root.traverse(node => {
    if (node instanceof Mesh || node instanceof Line) geometries.add(node.geometry);
    if (node instanceof Mesh || node instanceof Sprite || node instanceof Line) {
      const owned: Material[] = Array.isArray(node.material) ? node.material : [node.material];
      owned.forEach(material => {
        materials.add(material);
        Object.values(material).forEach(value => { if (value instanceof Texture) textures.add(value); });
      });
    }
  });
  textures.forEach(texture => texture.dispose());
  materials.forEach(material => material.dispose());
  geometries.forEach(geometry => geometry.dispose());
}

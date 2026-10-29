import { ConeGeometry, Group, SphereGeometry, Vector3 } from 'three';
import { ExplorationScene, ExplorationTheme } from './crazyflie-exploration';
import { SceneBuilder } from './crazyflie-scene-builder';

type DiscoveryKind = 'panda' | 'elephant' | 'zebra' | 'deer' | 'rabbit' | 'fox' | 'owl' | 'flamingo'
  | 'cow' | 'sheep' | 'pig' | 'hen' | 'duck' | 'palm' | 'bamboo' | 'fern' | 'sunflower' | 'orchid'
  | 'lotus' | 'succulent' | 'cherry' | 'apple' | 'orange' | 'pear' | 'carrot' | 'cabbage' | 'pumpkin'
  | 'clownfish' | 'shark' | 'ray' | 'octopus' | 'seahorse' | 'starfish' | 'crab' | 'shells'
  | 'telescope' | 'astronaut' | 'meteorite' | 'microscope' | 'magnet' | 'pendulum'
  | 'sandcastle' | 'tidepool' | 'lighthouse' | 'sailboat' | 'barn' | 'tractor' | 'duckpond';

function discoveryObject(kind: DiscoveryKind, b: SceneBuilder): Group {
  const g = new Group();
  g.name = `Discovery ${kind}`;
  g.userData.discoveryKind = kind;
  const { paint, box, ball, cylinder, rod, ring, add } = b;
  const cream = paint('#f4e8d1'), dark = paint('#334652'), green = paint('#71976a');
  const wood = paint('#a1805c'), gold = paint('#d8b15f');
  const eyes = (x: number, y: number, z: number, spread = 0.1): void => {
    for (const side of [-1, 1]) ball(g, dark, x, y, z + side * spread, 0.025);
  };
  if (['panda', 'elephant', 'zebra', 'deer', 'rabbit', 'fox', 'cow', 'sheep', 'pig'].includes(kind)) {
    const color = paint(kind === 'elephant' ? '#a2abb2' : kind === 'pig' ? '#d9aaa3'
      : kind === 'fox' ? '#cc9867' : kind === 'deer' ? '#b79873' : '#ece5d7');
    ball(g, color, 0, 0.65, 0, 0.5, 0.3, 0.25);
    for (const x of [-0.3, 0.3]) for (const z of [-0.16, 0.16]) {
      cylinder(g, kind === 'panda' || kind === 'cow' ? dark : color, x, 0.28, z, 0.075, 0.5);
    }
    ball(g, color, 0.47, 0.91, 0, 0.24, 0.23, 0.2);
    eyes(0.58, 0.97, 0, 0.17);
    for (const side of [-1, 1]) {
      if (kind === 'rabbit') ball(g, color, 0.4, 1.27, side * 0.12, 0.07, 0.3, 0.07);
      else if (kind === 'elephant') ball(g, color, 0.32, 0.91, side * 0.27, 0.16, 0.28, 0.075);
      else ball(g, kind === 'panda' ? dark : color, 0.4, 1.12, side * 0.16, 0.085);
      if (kind === 'panda') ball(g, dark, 0.6, 0.96, side * 0.15, 0.07, 0.09, 0.05);
      if (kind === 'cow') {
        ball(g, dark, side * 0.23, 0.82, -0.22, 0.17, 0.12, 0.04);
        cylinder(g, gold, 0.4, 1.2, side * 0.13, 0.025, 0.18);
      }
      if (kind === 'deer') {
        rod(g, wood, new Vector3(0.38, 1.1, side * 0.12), new Vector3(0.28, 1.5, side * 0.22), 0.025);
        rod(g, wood, new Vector3(0.32, 1.3, side * 0.18), new Vector3(0.48, 1.44, side * 0.28), 0.018);
      }
    }
    if (kind === 'zebra') for (let i = 0; i < 6; i++) {
      for (const side of [-1, 1]) box(g, dark, -0.35 + i * 0.13, 0.68, side * 0.24, 0.045, 0.35, 0.025);
    }
    if (kind === 'elephant') {
      rod(g, color, new Vector3(0.65, 0.85, 0), new Vector3(0.78, 0.3, 0), 0.085);
      ball(g, color, 0.83, 0.29, 0, 0.12, 0.07, 0.09);
    }
    if (kind === 'pig') ball(g, paint('#c88f91'), 0.7, 0.86, 0, 0.08, 0.09, 0.12);
    if (kind === 'fox') {
      ball(g, color, -0.6, 0.6, 0, 0.33, 0.13, 0.16);
      ball(g, cream, -0.83, 0.63, 0, 0.14, 0.12, 0.14);
    }
    if (kind === 'sheep') for (let i = 0; i < 6; i++) ball(g, cream, -0.33 + i * 0.13, 0.8, 0, 0.22);
  } else if (['owl', 'flamingo', 'hen', 'duck'].includes(kind)) {
    const feather = kind === 'flamingo' ? paint('#d5a1a5') : kind === 'owl' ? wood : cream;
    ball(g, feather, 0, 0.5, 0, 0.3, 0.25, 0.22);
    const headY = kind === 'flamingo' ? 1.2 : 0.85;
    cylinder(g, feather, 0.2, (headY + 0.5) / 2, 0, 0.055, headY - 0.5);
    ball(g, feather, 0.2, headY, 0, 0.17);
    eyes(0.28, headY + 0.04, 0, 0.13);
    ball(g, gold, 0.4, headY - 0.03, 0, 0.12, 0.04, 0.07);
    for (const side of [-1, 1]) {
      cylinder(g, gold, 0, 0.2, side * 0.1, 0.025, 0.4);
      ball(g, feather, -0.03, 0.56, side * 0.22, 0.21, 0.13, 0.04);
    }
    if (kind === 'hen') for (let i = 0; i < 3; i++) ball(g, paint('#c78573'), 0.1 + i * 0.07, 1, 0, 0.06);
  } else if (['palm', 'bamboo', 'fern', 'sunflower', 'orchid', 'lotus', 'succulent', 'cherry', 'apple', 'orange', 'pear'].includes(kind)) {
    if (['palm', 'cherry', 'apple', 'orange', 'pear'].includes(kind)) {
      cylinder(g, wood, 0, 0.75, 0, 0.075, 1.5);
      if (kind === 'palm') for (let i = 0; i < 7; i++) {
        const a = i * Math.PI * 2 / 7;
        const leaf = ball(g, green, Math.cos(a) * 0.4, 1.6, Math.sin(a) * 0.4, 0.65, 0.08, 0.16);
        leaf.rotation.y = -a;
      } else {
        for (const x of [-0.3, 0.3]) ball(g, kind === 'cherry' ? paint('#d6b1c2') : green, x, 1.55, 0, 0.5, 0.55, 0.48);
        for (let i = 0; i < 9; i++) {
          const a = i * 2.4;
          ball(g, paint(kind === 'orange' ? '#dfab56' : kind === 'pear' ? '#c1c879' : '#c98778'),
            Math.cos(a) * 0.48, 1.4 + i % 3 * 0.15, Math.sin(a) * 0.4, 0.075, kind === 'pear' ? 0.11 : 0.075);
        }
      }
    } else if (kind === 'bamboo') {
      for (const x of [-0.25, 0, 0.25]) {
        cylinder(g, green, x, 0.95, 0, 0.045, 1.9);
        for (let i = 1; i < 6; i++) {
          cylinder(g, cream, x, i * 0.3, 0, 0.047, 0.018);
          const leaf = ball(g, green, x + (i % 2 ? -0.14 : 0.14), i * 0.3 + 0.08, 0, 0.2, 0.045, 0.07);
          leaf.rotation.z = i % 2 ? -0.4 : 0.4;
        }
      }
    } else {
      cylinder(g, kind === 'lotus' ? paint('#86b8b4') : wood, 0, 0.06, 0, 0.43, 0.1);
      for (let i = 0; i < 8; i++) {
        const a = i * Math.PI / 4;
        const leaf = ball(g, green, Math.cos(a) * 0.22, 0.28, Math.sin(a) * 0.22, 0.3, 0.065, 0.1);
        leaf.rotation.set(0, -a, 0.3);
      }
      if (!['fern', 'succulent'].includes(kind)) {
        cylinder(g, green, 0, 0.5, 0, 0.025, 0.85);
        for (let i = 0; i < 8; i++) {
          const a = i * Math.PI / 4;
          ball(g, paint(kind === 'sunflower' ? '#e5c365' : kind === 'orchid' ? '#b9a2c6' : '#dba6b7'),
            Math.cos(a) * 0.2, 0.9 + Math.sin(a) * 0.2, 0, 0.13, 0.17, 0.06);
        }
        ball(g, gold, 0, 0.9, -0.06, 0.13, 0.13, 0.05);
      }
    }
  } else if (['carrot', 'cabbage', 'pumpkin'].includes(kind)) {
    box(g, wood, 0, 0.04, 0, 1.2, 0.08, 0.9);
    for (const x of [-0.36, 0, 0.36]) for (const z of [-0.22, 0.22]) {
      ball(g, kind === 'cabbage' ? green : paint('#d8a361'), x, 0.2, z, 0.17, kind === 'carrot' ? 0.24 : 0.16, 0.17);
      for (const side of [-1, 1]) ball(g, green, x + side * 0.07, 0.4, z, 0.12, 0.04, 0.055).rotation.z = side * 0.6;
    }
  } else if (['clownfish', 'shark', 'ray', 'octopus', 'seahorse', 'starfish', 'crab'].includes(kind)) {
    const color = paint(kind === 'clownfish' ? '#dca46c' : kind === 'shark' ? '#8aa8b6'
      : kind === 'octopus' ? '#b49bc0' : kind === 'crab' ? '#c89279' : '#d2bc87');
    if (kind === 'starfish') {
      ball(g, color, 0, 0.2, 0, 0.15, 0.06, 0.15);
      for (let i = 0; i < 5; i++) {
        const a = i * Math.PI * 2 / 5;
        rod(g, color, new Vector3(0, 0.2, 0), new Vector3(Math.cos(a) * 0.45, 0.16, Math.sin(a) * 0.45), 0.08);
      }
    } else if (kind === 'octopus' || kind === 'crab') {
      ball(g, color, 0, 0.52, 0, 0.28, kind === 'crab' ? 0.15 : 0.36, 0.25);
      for (let i = 0; i < 8; i++) {
        const a = i * Math.PI / 4;
        rod(g, color, new Vector3(0, 0.35, 0), new Vector3(Math.cos(a) * 0.55, 0.14, Math.sin(a) * 0.55), 0.045);
      }
      eyes(0.22, 0.63, 0, 0.12);
      if (kind === 'crab') for (const side of [-1, 1]) {
        ball(g, color, 0.3, 0.6, side * 0.4, 0.13, 0.13, 0.09);
        rod(g, color, new Vector3(0.2, 0.3, side * 0.15), new Vector3(0.3, 0.58, side * 0.4), 0.035);
      }
    } else if (kind === 'seahorse') {
      ball(g, color, 0, 0.6, 0, 0.12, 0.3, 0.1);
      ball(g, color, 0.08, 0.94, 0, 0.14);
      cylinder(g, color, 0.27, 0.92, 0, 0.04, 0.24).rotation.z = Math.PI / 2;
      ring(g, color, 0.14, 0.035, -0.07, 0.29, 0);
      eyes(0.14, 0.99, 0, 0.1);
    } else {
      ball(g, color, 0, 0.75, 0, 0.5, 0.2, kind === 'ray' ? 0.46 : 0.15);
      for (const side of [-1, 1]) ball(g, color, -0.1, 0.7, side * (kind === 'ray' ? 0.4 : 0.16),
        0.28, 0.04, kind === 'ray' ? 0.3 : 0.15);
      box(g, color, -0.54, 0.75, 0, 0.06, 0.35, 0.1).rotation.z = 0.4;
      eyes(0.32, 0.8, 0, 0.13);
      if (kind === 'clownfish') for (const x of [-0.25, 0.05, 0.25]) {
        ball(g, cream, x, 0.75, -0.14, 0.035, 0.15, 0.02);
        ball(g, cream, x, 0.75, 0.14, 0.035, 0.15, 0.02);
      }
      if (kind === 'shark') add(g, new ConeGeometry(0.17, 0.35, 3), color, -0.1, 1.02, 0);
    }
  } else if (kind === 'telescope' || kind === 'microscope' || kind === 'pendulum' || kind === 'magnet') {
    cylinder(g, dark, 0, 0.05, 0, 0.4, 0.1);
    if (kind === 'telescope') {
      for (const z of [-0.25, 0.25]) rod(g, dark, new Vector3(0, 0.85, 0), new Vector3(-0.2, 0.05, z), 0.025);
      const tube = cylinder(g, cream, 0.1, 1, 0, 0.12, 0.85);
      tube.rotation.z = -0.9;
      ball(g, paint('#7daabf'), 0.42, 1.25, 0, 0.12, 0.06, 0.12).rotation.z = -0.9;
    } else if (kind === 'microscope') {
      rod(g, cream, new Vector3(-0.2, 0.1, 0), new Vector3(-0.2, 0.9, 0), 0.075);
      box(g, dark, 0, 0.5, 0, 0.5, 0.035, 0.4);
      cylinder(g, cream, 0.12, 0.87, 0, 0.08, 0.5).rotation.z = -0.3;
    } else if (kind === 'magnet') {
      ring(g, paint('#bd887f'), 0.35, 0.09, 0, 0.65, 0);
      for (const x of [-0.35, 0.35]) box(g, cream, x, 0.42, 0, 0.17, 0.27, 0.18);
      box(g, dark, 0, 0.35, 0, 0.45, 0.32, 0.24);
    } else {
      for (const x of [-0.45, 0.45]) cylinder(g, cream, x, 0.7, 0, 0.025, 1.4);
      box(g, cream, 0, 1.4, 0, 0.95, 0.04, 0.04);
      for (let i = 0; i < 5; i++) {
        const x = -0.28 + i * 0.14;
        rod(g, dark, new Vector3(x, 1.4, 0), new Vector3(x, 0.65, 0), 0.008);
        ball(g, gold, x, 0.65, 0, 0.07);
      }
    }
  } else if (kind === 'astronaut') {
    box(g, cream, 0, 0.7, 0, 0.4, 0.5, 0.28);
    ball(g, cream, 0, 1.12, 0, 0.25);
    ball(g, gold, 0, 1.14, -0.18, 0.19, 0.15, 0.09);
    for (const side of [-1, 1]) {
      cylinder(g, cream, side * 0.13, 0.28, 0, 0.09, 0.4);
      rod(g, cream, new Vector3(side * 0.2, 0.85, 0), new Vector3(side * 0.4, 0.63, 0), 0.08);
    }
    box(g, dark, 0, 0.72, 0.2, 0.3, 0.4, 0.2);
  } else if (kind === 'meteorite') {
    const rock = ball(g, paint('#9d9b99'), 0, 0.3, 0, 0.45, 0.3, 0.4);
    rock.rotation.z = 0.2;
    for (let i = 0; i < 4; i++) ball(g, dark, -0.2 + i * 0.12, 0.51, 0.1, 0.06, 0.025, 0.06);
  } else if (kind === 'sandcastle') {
    box(g, paint('#d9bc85'), 0, 0.35, 0, 0.85, 0.7, 0.7);
    for (const x of [-0.4, 0.4]) for (const z of [-0.32, 0.32]) {
      cylinder(g, gold, x, 0.5, z, 0.14, 1);
      add(g, new ConeGeometry(0.2, 0.25, 12), paint('#d9bc85'), x, 1.12, z);
    }
    box(g, dark, 0, 0.2, -0.36, 0.22, 0.4, 0.025);
  } else if (kind === 'lighthouse') {
    cylinder(g, cream, 0, 0.9, 0, 0.34, 1.8, 0.24);
    for (const y of [0.45, 1.05]) cylinder(g, paint('#c98d7e'), 0, y, 0, 0.32 - y * 0.04, 0.16);
    cylinder(g, gold, 0, 1.98, 0, 0.25, 0.3);
    add(g, new ConeGeometry(0.4, 0.3, 16), dark, 0, 2.28, 0);
    ring(g, dark, 0.38, 0.035, 0, 1.8, 0).rotation.x = -Math.PI / 2;
  } else if (kind === 'sailboat') {
    ball(g, wood, 0, 0.25, 0, 0.65, 0.2, 0.28);
    cylinder(g, dark, 0, 0.95, 0, 0.025, 1.6);
    box(g, cream, 0.24, 1.15, 0, 0.46, 0.85, 0.025);
    box(g, paint('#89b4ba'), -0.18, 0.95, 0, 0.3, 0.5, 0.025);
  } else if (kind === 'barn') {
    box(g, paint('#bd8d77'), 0, 0.65, 0, 1.3, 1.3, 1);
    const roof = add(g, new ConeGeometry(1, 0.6, 4), dark, 0, 1.6, 0);
    roof.rotation.y = Math.PI / 4;
    box(g, cream, 0, 0.5, -0.51, 0.7, 1, 0.025);
    for (const side of [-1, 1]) rod(g, wood, new Vector3(-0.3, side < 0 ? 0.1 : 0.9, -0.535),
      new Vector3(0.3, side < 0 ? 0.9 : 0.1, -0.535), 0.025);
  } else if (kind === 'tractor') {
    box(g, green, 0.13, 0.5, 0, 0.85, 0.4, 0.45);
    box(g, cream, -0.3, 1, 0, 0.5, 0.08, 0.6);
    for (const z of [-0.22, 0.22]) {
      rod(g, dark, new Vector3(-0.5, 0.55, z), new Vector3(-0.5, 1, z), 0.025);
      for (const x of [-0.4, 0.48]) {
        const wheel = cylinder(g, dark, x, x < 0 ? 0.32 : 0.23, z * 1.5, x < 0 ? 0.32 : 0.23, 0.15);
        wheel.rotation.x = Math.PI / 2;
      }
    }
    cylinder(g, dark, 0.35, 0.9, 0.1, 0.03, 0.6);
  } else if (kind === 'tidepool' || kind === 'duckpond') {
    cylinder(g, paint('#89b7b6'), 0, 0.035, 0, 0.6, 0.07);
    for (let i = 0; i < 7; i++) {
      const a = i * Math.PI * 2 / 7;
      ball(g, paint('#aaa99a'), Math.cos(a) * 0.57, 0.08, Math.sin(a) * 0.57, 0.14, 0.08, 0.13);
    }
    const animal = discoveryObject(kind === 'duckpond' ? 'duck' : 'starfish', b);
    animal.scale.setScalar(0.45);
    g.add(animal);
  } else if (kind === 'shells') {
    for (let i = 0; i < 5; i++) {
      const shell = ball(g, paint(i % 2 ? '#e7ccbc' : '#d8d1b3'), -0.4 + i * 0.2, 0.12, i % 2 * 0.24, 0.16, 0.09, 0.21);
      shell.rotation.y = i * 0.6;
      for (let j = 0; j < 3; j++) rod(g, cream, new Vector3(-0.4 + i * 0.2, 0.2, i % 2 * 0.24 - 0.1),
        new Vector3(-0.48 + i * 0.2 + j * 0.08, 0.16, i % 2 * 0.24 + 0.15), 0.008);
    }
  }
  return g;
}

type Placement = readonly [DiscoveryKind, number, number, number?, number?];
const COLLECTIONS: Partial<Record<ExplorationTheme, readonly Placement[]>> = {
  animals: [['panda', 5.7, 3.8, 0.85], ['rabbit', 3.2, 3.8, 0.7], ['elephant', 5.5, 0.9, 0.95],
    ['zebra', 4.5, -1.7, 0.8], ['deer', -5.4, 0.7, 0.8], ['flamingo', -0.6, 2.6, 0.75],
    ['fox', -1.4, 4.8, 0.7], ['owl', 1.7, -4.8, 0.8], ['panda', -3.1, -4.8, 0.65],
    ['rabbit', 2.9, 4.5, 0.55], ['bamboo', -0.5, -5.2, 0.7], ['bamboo', -1.2, -5.2, 0.7],
    ['fern', 2, 4.5, 0.6], ['fern', -4, 1.1, 0.6], ['owl', 5.7, -2.6, 0.65],
    ['deer', 0.6, -4.7, 0.7], ['sunflower', 6, 2, 0.7], ['succulent', -5.8, -1.6, 0.7]],
  botanical: [['cherry', -1.2, -0.8, 0.85], ['palm', 6, -1.1, 0.9], ['bamboo', -6, 1.7, 0.8],
    ['fern', -3, 2.4, 0.8], ['fern', -2, 1.5, 0.8], ['sunflower', -1.6, -4.3, 0.8],
    ['lotus', 1, -4.6, 0.8], ['fern', 1.5, 3.8, 0.85], ['orchid', -3.2, -2.4, 0.7],
    ['succulent', -6.3, -0.3, 0.8], ['orchid', 3.1, 1.7, 0.65], ['bamboo', -0.8, -3.7, 0.7],
    ['sunflower', 0.8, -3.8, 0.7], ['lotus', 1.2, 4.8, 0.6], ['succulent', 7, -0.1, 0.7],
    ['fern', 4.8, 2.5, 0.7], ['orchid', -7.2, 1.2, 0.7], ['sunflower', 1.4, -2.2, 0.8]],
  science: [['microscope', -1, 1.5, 0.8], ['magnet', 0.5, -1.5, 0.8], ['pendulum', 2, 1.7, 0.85],
    ['telescope', -4.8, 4.8, 0.9], ['microscope', 4, -4.8, 0.8], ['magnet', 7.5, -3.1, 0.8],
    ['pendulum', -5, -2, 0.8], ['meteorite', -1.5, -1.3, 0.8], ['microscope', 7.5, 2.5, 0.7],
    ['magnet', 4.4, -1.8, 0.7], ['pendulum', -3.5, -1.7, 0.7], ['telescope', 1, 1.5, 0.7]],
  space: [['telescope', -4, 1, 0.9], ['telescope', -7, 1.8, 0.9], ['telescope', 7.5, -1.2, 0.9],
    ['astronaut', 6, 1, 0.8], ['meteorite', -4.3, -5.8, 0.8], ['meteorite', -7.3, -2, 0.8],
    ['astronaut', -7, 3, 0.7], ['telescope', 4.2, 5.8, 0.85], ['meteorite', 6, -6, 0.8],
    ['astronaut', 7.7, -2.7, 0.7], ['meteorite', -3.8, 5.6, 0.75], ['telescope', 4.2, -5.8, 0.75]],
  ocean: [['clownfish', -2.3, 0.6, 0.7], ['shark', -3.4, -0.6, 0.9], ['ray', -3.4, 0.8, 0.8],
    ['octopus', -6.5, -0.4, 0.85], ['seahorse', 6.7, 1, 0.8], ['starfish', -2.6, -4.8, 0.8],
    ['crab', 5.2, 5, 0.8], ['clownfish', -2.7, -0.9, 0.65], ['seahorse', -6.5, 1.3, 0.8],
    ['octopus', 7, -0.8, 0.7], ['ray', 1.7, 4.6, 0.7], ['starfish', -1.8, 4.9, 0.8],
    ['crab', -6.5, -2.7, 0.7], ['clownfish', 1.8, -5, 0.6], ['seahorse', 6.6, -4, 0.7],
    ['starfish', 0.1, 4.7, 0.8], ['shark', -3.5, 0, 0.7], ['octopus', 3.9, -4.8, 0.7]],
  beach: [['palm', -10, -5, 1.2], ['palm', -10, -2, 1.1], ['palm', -10, 5, 1.1],
    ['palm', -8, 8, 1], ['crab', 5, 1.8, 0.8], ['crab', 4, 3.5, 0.7],
    ['starfish', 7, 1.5, 0.8], ['starfish', 6, -7, 0.8], ['shells', 2, 6, 0.9],
    ['shells', -2, -7, 0.8], ['tidepool', 5, 8, 1.3], ['tidepool', 5, -1, 1],
    ['sailboat', 10, 1.5, 0.8], ['sandcastle', -2, 7.5, 0.7], ['crab', 3.5, 0.3, 0.7],
    ['shells', 4.5, 0.2, 0.8], ['starfish', 8, 8, 0.7], ['palm', -5, -8.5, 1]],
  farm: [['cow', -4, 1, 1], ['sheep', -3, 2.8, 0.85], ['pig', -6, 2, 0.85],
    ['hen', -7, 0.2, 0.8], ['rabbit', -5, -1, 0.7], ['duck', -2.5, -6.8, 0.8],
    ['apple', 8.5, 2, 1], ['orange', 10, 4, 1], ['pear', 9.5, 7.5, 1],
    ['apple', 6, 8, 1], ['orange', 3, 8, 1], ['carrot', 1, 4, 1],
    ['cabbage', 2.5, 5.5, 1], ['pumpkin', 1, 7, 1], ['carrot', 3.5, 6.5, 1],
    ['sunflower', -9, 2, 1], ['sunflower', -9, 3.5, 1], ['sheep', -5, 2.8, 0.7],
    ['hen', -6.2, -0.4, 0.6], ['pig', -3.3, 0.1, 0.7], ['bamboo', -10, -3, 1]],
};

export function buildDiscoveryCollections(root: Group, definition: ExplorationScene, b: SceneBuilder): void {
  const templates = new Map<DiscoveryKind, Group>();
  for (const [kind, x, z, scale = 1, angle = 0] of COLLECTIONS[definition.id] ?? []) {
    let template = templates.get(kind);
    if (!template) {
      template = discoveryObject(kind, b);
      templates.set(kind, template);
    }
    const object = template.clone(true);
    object.position.set(x, 0, z);
    object.scale.setScalar(scale);
    object.rotation.y = angle;
    root.add(object);
  }
}

export function buildOutdoorExhibit(parent: Group, theme: 'beach' | 'farm', index: number, b: SceneBuilder): void {
  const kinds: readonly DiscoveryKind[] = theme === 'beach'
    ? ['sandcastle', 'tidepool', 'lighthouse', 'sailboat', 'shells']
    : ['barn', 'tractor', 'apple', 'carrot', 'duckpond'];
  parent.add(discoveryObject(kinds[index], b));
}

export function buildOutdoorArchitecture(root: Group, definition: ExplorationScene, b: SceneBuilder,
  text: (key: string) => string): void {
  const architecture = new Group();
  architecture.name = `Architecture ${definition.id}`;
  root.add(architecture);
  b.floor(architecture, definition.boundary, definition.floor);
  b.label(architecture, text(definition.nameKey), 0, 3.2, -8.5, 3);
  const wood = b.paint('#a78760'), cream = b.paint('#eee0bd');
  const path = (from: readonly [number, number], to: readonly [number, number]): void => {
    b.wall(architecture, from, to, '#d7c6a0', 0.012, 1.1).name = 'Outdoor path';
  };
  if (definition.id === 'beach') {
    const water = b.floor(architecture, [[6.5, -9], [9.5, -9], [12.5, -6.8], [12.5, 6.8],
      [9, 9.5], [6.5, 9.5], [5.7, 4], [6.4, 0], [5.8, -4]], '#8bbfc4');
    water.position.y += 0.025;
    water.name = 'Shallow sea';
    for (let i = 0; i < 10; i++) {
      b.box(architecture, cream, 7.5 + i % 3 * 1.3, 0.03, -7.5 + i * 1.6, 1.3, 0.012, 0.05).rotation.y = 0.1;
    }
    path([-10, 1], [-3, 1]);
    for (const [x, z] of [[-7, 2], [-3, -2], [0, 7.5], [-8, -7]]) {
      const umbrella = new Group();
      umbrella.name = 'Beach umbrella';
      umbrella.position.set(x, 0, z);
      b.cylinder(umbrella, wood, 0, 0.9, 0, 0.025, 1.8);
      b.add(umbrella, new SphereGeometry(0.75, 16, 8, 0, Math.PI * 2, 0, Math.PI / 2),
        b.paint(x < -5 ? '#c99282' : '#89aeb2'), 0, 1.65, 0);
      b.box(umbrella, cream, 0, 0.025, 0.6, 0.7, 0.025, 1.3);
      architecture.add(umbrella);
    }
    const tower = new Group();
    tower.name = 'Lifeguard tower';
    tower.position.set(-9, 0, 6.8);
    for (const x of [-0.45, 0.45]) for (const z of [-0.4, 0.4]) b.box(tower, wood, x, 0.9, z, 0.08, 1.8, 0.08);
    b.box(tower, cream, 0, 1.85, 0, 1.2, 0.12, 1.1);
    b.box(tower, b.paint('#b9c9c4'), 0, 2.2, 0.35, 1.1, 0.6, 0.1);
    b.add(tower, new ConeGeometry(1, 0.45, 4), b.paint('#a7bba9'), 0, 2.8, 0).rotation.y = Math.PI / 4;
    architecture.add(tower);
  } else {
    path([0, 0], [-8, -4]); path([0, 0], [8, -4]); path([0, 0], [0, 8]);
    for (const z of [-1.8, 3.7]) {
      for (let i = 0; i < 7; i++) b.box(architecture, wood, -7 + i * 0.9, 0.4, z, 0.06, 0.8, 0.06);
      for (const y of [0.3, 0.65]) b.box(architecture, cream, -4.3, y, z, 5.4, 0.05, 0.05);
    }
    for (const x of [-7, -1.6]) for (const [from, to] of [[-1.8, 0.3], [1.7, 3.7]]) {
      for (const y of [0.3, 0.65]) b.wall(architecture, [x, from], [x, to], '#eee0bd', 0.05, 0.05).position.y = y;
    }
    const windmill = new Group();
    windmill.name = 'Farm windmill';
    windmill.position.set(-9.8, 0, -7.7);
    b.cylinder(windmill, cream, 0, 1.1, 0, 0.45, 2.2, 0.25);
    for (let i = 0; i < 4; i++) {
      const a = i * Math.PI / 2;
      const blade = b.box(windmill, wood, Math.sin(a) * 0.45, 2.25 + Math.cos(a) * 0.45, -0.3, 0.15, 0.85, 0.05);
      blade.rotation.z = -a;
    }
    architecture.add(windmill);
    for (const x of [1, 2.5, 4]) b.box(architecture, b.paint('#927c5d'), x, 0.015, 5.5, 0.8, 0.025, 5);
    for (const [x, z] of [[-8, -3], [7, 0], [4, -7.8]]) {
      b.box(architecture, wood, x, 0.4, z, 1.5, 0.1, 0.6);
      for (const side of [-1, 1]) b.box(architecture, cream, x + side * 0.5, 0.2, z, 0.08, 0.4, 0.5);
    }
  }
}

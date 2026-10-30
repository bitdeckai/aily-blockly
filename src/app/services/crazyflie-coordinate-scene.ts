import { ArrowHelper, GridHelper, Group, MathUtils, PerspectiveCamera, Vector3 } from 'three';
import { CRAZYFLIE_BODY_AXES } from './crazyflie-attitude';
import { COORDINATE_ROOM_SIZE } from './crazyflie-exploration';
import { createSceneBuilder } from './crazyflie-scene-builder';

export function createCoordinateScene(): Group {
  const root = new Group();
  root.name = 'Coordinate test scene';
  root.userData.coordinates = true;
  const grids = new Group();
  grids.name = 'Coordinate grids';
  root.add(grids);
  const minor = new Group();
  minor.name = 'Coordinate minor grid';
  grids.add(minor);
  const size = COORDINATE_ROOM_SIZE.width;
  for (const plane of ['XY', 'XZ', 'YZ']) {
    for (const spacing of [1, 0.1]) {
      const grid = new GridHelper(size, Math.round(size / spacing), '#8da6ba', '#8da6ba');
      grid.name = `${plane} grid ${spacing} m`;
      if (plane === 'XZ') grid.rotation.x = Math.PI / 2;
      if (plane === 'YZ') grid.rotation.z = Math.PI / 2;
      const materials = Array.isArray(grid.material) ? grid.material : [grid.material];
      materials.forEach(material => {
        material.transparent = true;
        material.opacity = (plane === 'XY' ? 0.5 : 0.22) * (spacing === 1 ? 1 : 0.4);
        material.depthWrite = false;
        material.toneMapped = false;
      });
      (spacing === 1 ? grids : minor).add(grid);
    }
  }
  minor.visible = false;
  const extent = size / 2;
  for (const axis of CRAZYFLIE_BODY_AXES) {
    const arrow = new ArrowHelper(axis.direction, axis.direction.clone().multiplyScalar(-extent),
      size + 0.15, axis.color, 0.12, 0.06);
    arrow.name = `World ${axis.label} axis`;
    root.add(arrow);
    const { label } = createSceneBuilder(axis.color);
    const tip = axis.direction.clone().multiplyScalar(extent + 0.35);
    label(root, `+${axis.label} (m)`, tip.x, tip.y, tip.z, 0.7);
    const offset = axis.label === 'X' ? new Vector3(0, 0, -0.18) : new Vector3(0.18, 0, 0);
    for (let metre = -extent; metre <= extent; metre++) {
      if (metre === 0) continue;
      const position = axis.direction.clone().multiplyScalar(metre).add(offset);
      label(root, String(metre), position.x, position.y, position.z, 0.4);
    }
  }
  createSceneBuilder('#8da6ba').label(root, 'O (0, 0, 0)', 0.3, -0.15, 0.3, 0.8);
  return root;
}

export function updateCoordinateGrid(root: Group, camera: PerspectiveCamera, viewportHeight: number): 0.1 | 1 {
  const distance = Math.max(0.01, camera.position.length());
  const minorSpacingPixels = 0.1 * viewportHeight
    / (2 * Math.tan(MathUtils.degToRad(camera.getEffectiveFOV()) / 2) * distance);
  const spacing = minorSpacingPixels >= 8 ? 0.1 : 1;
  const minor = root.getObjectByName('Coordinate minor grid');
  if (minor) minor.visible = spacing === 0.1;
  return spacing;
}

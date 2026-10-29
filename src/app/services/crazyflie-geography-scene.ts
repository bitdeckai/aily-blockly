import { ExtrudeGeometry, Float32BufferAttribute, Group, LineBasicMaterial, LineSegments, BufferGeometry, Mesh, MeshStandardMaterial, Shape, Path } from 'three';
import { ExplorationProgress, ExplorationScene, explorationPointPosition, EXPLORATION_RADIUS_M } from './crazyflie-exploration';
import { geographyPosition, geographyRegionName } from './crazyflie-geography';
import { SceneBuilder } from './crazyflie-scene-builder';

interface GeographySceneState {
  definition: ExplorationScene;
  target: Group;
  halo: Mesh;
  regions: { id: number; material: MeshStandardMaterial; color: string }[];
}
const scenes = new WeakMap<Group, GeographySceneState>();

export function buildGeographyScene(root: Group, definition: ExplorationScene, b: SceneBuilder,
  text: (key: string) => string, locale: string): void {
  const map = definition.geography;
  if (!map) throw new Error('Geography scene requires a map definition');
  root.userData.geography = true;
  const architecture = new Group();
  architecture.name = `Architecture ${definition.id}`;
  root.add(architecture);
  b.floor(architecture, definition.boundary, definition.floor);
  const palette = ['#d7c6a0', '#b9c9a1', '#ddb49c', '#b0c9cd', '#c5b8d2', '#ded09c', '#a8c3b0'];
  const regions: GeographySceneState['regions'] = [];
  const borderMaterial = new LineBasicMaterial({ color: '#596f77', transparent: true, opacity: 0.65 });
  for (const point of definition.points) {
    const region = point.region;
    if (!region) throw new Error('Geography checkpoint is missing region data');
    const group = new Group();
    group.name = `Region ${region.code}`;
    group.userData.regionId = point.id;
    const color = palette[(point.id - 1) % palette.length];
    const material = new MeshStandardMaterial({ color, roughness: 0.85, metalness: 0 });
    const borders: number[] = [];
    const shapes: Shape[] = [];
    for (const polygon of region.polygons) {
      const shape = new Shape();
      polygon.forEach((ring, index) => {
        const path = index ? new Path() : shape;
        ring.forEach(([lon, lat], index) => {
          const { x, z } = geographyPosition(map, lon, lat);
          if (index) path.lineTo(x, -z); else path.moveTo(x, -z);
        });
        path.closePath();
        if (index) shape.holes.push(path);
        for (let i = 1; i < ring.length; i++) {
          for (const [lon, lat] of [ring[i - 1], ring[i]]) {
            const { x, z } = geographyPosition(map, lon, lat);
            borders.push(x, 0.055, z);
          }
        }
      });
      shapes.push(shape);
    }
    const mesh = new Mesh(new ExtrudeGeometry(shapes, { depth: 0.045, bevelEnabled: false }), material);
    mesh.rotation.x = -Math.PI / 2;
    group.add(mesh);
    const geometry = new BufferGeometry();
    geometry.setAttribute('position', new Float32BufferAttribute(borders, 3));
    group.add(new LineSegments(geometry, borderMaterial));
    root.add(group);
    regions.push({ id: point.id, material, color });
    if (map === 'china') {
      const name = geographyRegionName(region, locale).replace(/(维吾尔自治区|壮族自治区|回族自治区|特别行政区|自治区|省|市)$/u, '');
      b.label(root, name, -point.forward, 0.2, point.left, region.code === 'CN-HK' || region.code === 'CN-MO' ? 0.6 : 1);
    }
  }
  b.pad(root);
  b.label(root, text(definition.nameKey), 0, 1.1, -definition.size.depth / 2 + 0.8, 3);
  const target = new Group();
  target.name = 'Geography target';
  target.visible = false;
  const marker = new MeshStandardMaterial({ color: '#e8b85d', roughness: 0.65 });
  const halo = b.ring(target, marker, EXPLORATION_RADIUS_M, 0.022, 0, 0, 0);
  halo.name = 'Checkpoint halo';
  halo.rotation.x = -Math.PI / 2;
  b.ring(target, marker, EXPLORATION_RADIUS_M + 0.07, 0.01, 0, 0.02, 0).rotation.x = -Math.PI / 2;
  root.add(target);
  scenes.set(root, { definition, target, halo, regions });
}

export function updateGeographyMarkers(root: Group, progress: ExplorationProgress, enabled: boolean, selectedId: number | null): void {
  const state = scenes.get(root);
  if (!state) throw new Error('Geography scene state is missing');
  const point = state.definition.points.find(point => point.id === selectedId);
  state.target.visible = enabled && point !== undefined;
  if (point) {
    const target = explorationPointPosition(point);
    state.target.position.set(target.x, target.y, target.z);
    state.target.userData.checkpointId = point.id;
    const material = state.halo.material;
    if (material instanceof MeshStandardMaterial) material.color.set(progress.visited.includes(point.id) ? '#65b995'
      : progress.dwelling === point.id ? '#f5d992' : '#e8b85d');
  }
  for (const region of state.regions) {
    region.material.color.set(enabled && region.id === selectedId ? '#83c6d4'
      : enabled && progress.visited.includes(region.id) ? '#85b493' : region.color);
  }
}

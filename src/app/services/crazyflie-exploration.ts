export type ExplorationTheme = 'animals' | 'botanical' | 'science' | 'space' | 'ocean';
export type CrazyflieRoomPreset = 'classroom' | 'home' | 'custom' | ExplorationTheme;

export const EXPLORATION_RADIUS_M = 0.25;
export const EXPLORATION_DWELL_MS = 1000;
export const EXPLORATION_LAUNCH_Y = 0.06;
export const HOME_ROOM_SIZE = { width: 14, depth: 12, height: 3.2 } as const;

export interface ExplorationPoint {
  readonly id: number;
  readonly nameKey: string;
  readonly forward: number;
  readonly left: number;
  readonly height: number;
  readonly exhibit: { readonly x: number; readonly z: number };
  readonly companions: readonly { readonly x: number; readonly z: number }[];
}

export interface ExplorationScene {
  readonly id: ExplorationTheme;
  readonly nameKey: string;
  readonly accent: string;
  readonly floor: string;
  readonly background: string;
  readonly stations: readonly string[];
  readonly points: readonly ExplorationPoint[];
  readonly size: { readonly width: number; readonly depth: number; readonly height: number };
  readonly boundary: readonly (readonly [number, number])[];
  readonly reference: { readonly name: string; readonly url: string };
}

type StationPlacement = readonly [
  name: string, x: number, z: number, height: number, exhibitX: number, exhibitZ: number,
  companions?: readonly (readonly [number, number])[],
];

function explorationScene(
  id: ExplorationTheme, accent: string, floor: string, background: string,
  size: ExplorationScene['size'], boundary: ExplorationScene['boundary'],
  reference: ExplorationScene['reference'], placements: readonly StationPlacement[],
): ExplorationScene {
  return {
    id, accent, floor, background, size, boundary, reference,
    stations: placements.map(([name]) => name),
    nameKey: `CRAZYFLIE_EXPLORATION.${id.toUpperCase()}`,
    points: placements.map(([name, x, z, height, exhibitX, exhibitZ, companions], index) => ({
      forward: -x, left: z, height, id: index + 1, exhibit: { x: exhibitX, z: exhibitZ },
      companions: (companions ?? [[exhibitX - 0.95, exhibitZ], [exhibitX + 0.95, exhibitZ]])
        .map(([x, z]) => ({ x, z })),
      nameKey: `CRAZYFLIE_EXPLORATION.STATIONS.${name}`,
    })),
  };
}

export const EXPLORATION_SCENES: readonly ExplorationScene[] = [
  explorationScene('animals', '#d2a15e', '#c4b397', '#e3ded2',
    { width: 14, depth: 12, height: 4.8 },
    [[-7, -4.8], [-5.8, -6], [5.8, -6], [7, -4.8], [7, 4.8], [5.8, 6], [-5.8, 6], [-7, 4.8]],
    { name: 'Shanghai Natural History Museum', url: 'https://perkinswill.com/project/shanghai-natural-history-museum/' },
    [['DINOSAUR', -1.2, -1.2, 0.6, -2.6, -2.5], ['GIRAFFE', -5, 2.4, 0.8, -5, 4],
      ['PENGUIN', 1, 4, 0.6, 1, 5.1], ['BUTTERFLY', 4, -3.5, 1, 5, -4.7],
      ['WHALE', -4.8, -3, 0.8, -5.3, -4.7]]),
  explorationScene('botanical', '#73aa88', '#b6bea0', '#dbe6d6',
    { width: 16, depth: 11, height: 5 },
    [[-7.9, -3.2], [-2.4, -3.2], [-2.4, -5.4], [2.4, -5.4], [2.4, -3.2], [7.9, -3.2],
      [7.9, 3.2], [2.4, 3.2], [2.4, 5.4], [-2.4, 5.4], [-2.4, 3.2], [-7.9, 3.2]],
    { name: 'Royal Botanic Gardens, Kew', url: 'https://www.kew.org/kew-gardens/visit-kew-gardens/map' },
    [['TREE', -3, 0, 0.9, -4.4, 0, [[-4.4, -1.1], [-4.4, 1.1]]], ['FLOWER', -0.4, 3, 0.6, -0.4, 4.3],
      ['CACTUS', 5, 1.3, 0.7, 6.4, 1.3, [[6.4, 0.2], [6.4, 2.4]]], ['MUSHROOM', 3, -1.5, 0.6, 4.4, -2.3],
      ['SEED', -5, -2.4, 0.8, -6.4, -2.3, [[-6.4, -1.2], [-7.3, -1.8]]]]),
  explorationScene('science', '#68a8bc', '#a8bbc2', '#dce6e9',
    { width: 18, depth: 12, height: 4.8 },
    [[-8.8, -3.2], [2.5, -3.2], [2.5, -5.8], [8.8, -5.8], [8.8, 3.2],
      [-3.5, 3.2], [-3.5, 5.8], [-8.8, 5.8]],
    { name: 'Science Museum, London', url: 'https://www.sciencemuseum.org.uk/map' },
    [['ROBOT', -3, 0, 0.8, -3, -1.6], ['SOLAR', -6, 3.3, 1, -7.3, 4.3],
      ['ROCKET', 5, -3.5, 0.9, 6.5, -4.2], ['GEARS', 5, 1.5, 0.6, 6.5, 1.5, [[6.5, 0.4], [6.5, 2.6]]],
      ['ENERGY', -6, -1, 0.8, -7.3, -1.5, [[-7.3, -0.4], [-7.3, -2.5]]]]),
  explorationScene('space', '#9d95ca', '#858ca8', '#222e4a',
    { width: 18, depth: 14, height: 5 },
    [[-8.8, -6.8], [-3, -6.8], [-3, -2.5], [3, -2.5], [3, -6.8], [8.8, -6.8],
      [8.8, 6.8], [3, 6.8], [3, 2.5], [-3, 2.5], [-3, 6.8], [-8.8, 6.8]],
    { name: 'Smithsonian National Air and Space Museum',
      url: 'https://airandspace.si.edu/multimedia-gallery/image/nmb-master-map-north-facing-260629png' },
    [['BASE', -5, 3.8, 0.8, -6.5, 4.7], ['STATION', -5, -3.4, 1.2, -6.5, -4.7],
      ['SATELLITE', 5, -3.8, 1.1, 6.5, -4.7], ['ROVER', 5, 3.8, 0.6, 6.5, 4.7],
      ['PLANET', 0, 1.4, 1, 0, -1.4]]),
  explorationScene('ocean', '#5cb6b4', '#a7bdb5', '#b9d8db',
    { width: 16, depth: 12, height: 4.8 },
    [[-8, -4], [-6, -6], [6, -6], [8, -4], [8, 4], [6, 6], [-6, 6], [-8, 4]],
    { name: 'Osaka Aquarium Kaiyukan', url: 'https://www.kaiyukan.com/info/area/map/' },
    [['CORAL', -4, -3.7, 0.6, -5, -4.7], ['TURTLE', 1, -3.2, 0.8, 1, -4.7],
      ['JELLYFISH', 4.5, -1.8, 1.1, 5.8, -2.6], ['SHIP', 4.2, 2.6, 0.7, 5.5, 3.7],
      ['SUBMARINE', -3.7, 3.7, 0.9, -5, 4.7]]),
];

export const CRAZYFLIE_SCENE_OPTIONS: readonly { id: Exclude<CrazyflieRoomPreset, 'custom'>; nameKey: string }[] = [
  { id: 'classroom', nameKey: 'CRAZYFLIE_EXPLORATION.CLASSROOM' },
  { id: 'home', nameKey: 'CRAZYFLIE_EXPLORATION.HOME' },
  ...EXPLORATION_SCENES.map(({ id, nameKey }) => ({ id, nameKey })),
];

export function getExplorationScene(preset: CrazyflieRoomPreset): ExplorationScene | undefined {
  return EXPLORATION_SCENES.find(scene => scene.id === preset);
}

export function isSelectableRoomPreset(value: string): value is Exclude<CrazyflieRoomPreset, 'custom'> {
  return CRAZYFLIE_SCENE_OPTIONS.some(scene => scene.id === value);
}

export function explorationPointPosition(point: ExplorationPoint): { x: number; y: number; z: number } {
  return { x: -point.forward, y: EXPLORATION_LAUNCH_Y + point.height, z: point.left };
}

export function explorationGuidance(
  pose: { x: number; y: number; z: number; yaw: number }, point: ExplorationPoint,
): { forward: number; left: number; up: number; distance: number; inside: boolean } {
  const target = explorationPointPosition(point);
  if (![pose.x, pose.y, pose.z, pose.yaw, target.x, target.y, target.z].every(Number.isFinite)) {
    throw new Error('Exploration guidance requires a finite simulation pose and target');
  }
  const dx = target.x - pose.x;
  const dz = target.z - pose.z;
  const up = target.y - pose.y;
  const distance = Math.hypot(dx, up, dz);
  return {
    forward: -Math.cos(pose.yaw) * dx + Math.sin(pose.yaw) * dz,
    left: Math.sin(pose.yaw) * dx + Math.cos(pose.yaw) * dz,
    up, distance, inside: distance <= EXPLORATION_RADIUS_M,
  };
}

export interface ExplorationProgress {
  readonly visited: readonly number[];
  readonly dwelling: number | null;
  readonly dwellPercent: number;
}

export class ExplorationTracker {
  private visited = new Set<number>();
  private dwelling: number | null = null;
  private enteredAt = 0;
  private lastTime = 0;
  private readonly points: readonly ExplorationPoint[];

  constructor(points: readonly ExplorationPoint[]) {
    this.points = points;
  }

  update(position: { x: number; y: number; z: number }, now: number, active: boolean): ExplorationProgress {
    const valid = [position.x, position.y, position.z, now].every(Number.isFinite);
    const target = active && valid && now >= this.lastTime
      ? this.points.find(point => {
        const goal = explorationPointPosition(point);
        return !this.visited.has(point.id)
          && Math.hypot(position.x - goal.x, position.y - goal.y, position.z - goal.z) <= EXPLORATION_RADIUS_M;
      }) : undefined;
    this.lastTime = Number.isFinite(now) ? now : 0;
    if (!target) {
      this.dwelling = null;
    } else {
      if (this.dwelling !== target.id) {
        this.dwelling = target.id;
        this.enteredAt = now;
      }
      if (now - this.enteredAt >= EXPLORATION_DWELL_MS) {
        this.visited.add(target.id);
        this.dwelling = null;
      }
    }
    return {
      visited: [...this.visited],
      dwelling: this.dwelling,
      dwellPercent: this.dwelling === null ? 0
        : Math.min(100, Math.floor((now - this.enteredAt) / EXPLORATION_DWELL_MS * 100)),
    };
  }
}

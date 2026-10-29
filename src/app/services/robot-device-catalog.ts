export const CRAZYFLIE_DEVICE_PACKAGE = '@aily-project/board-crazyflie';

export interface RobotDevice {
  name: string;
  nickname: string;
  version: string;
  img: string;
  imgLocalPath?: string;
  description: string;
  url: string;
  brand: string;
  type: string;
  mode: string[];
  sourcePath: string;
}

export function isSupportedRobotDevice(name: unknown): boolean {
  return name === CRAZYFLIE_DEVICE_PACKAGE;
}

export function isSupportedRobotProject(value: unknown): boolean {
  if (!value || typeof value !== 'object' || !('dependencies' in value)) return false;
  const dependencies = value.dependencies;
  return !!dependencies && typeof dependencies === 'object' &&
    CRAZYFLIE_DEVICE_PACKAGE in dependencies &&
    Object.keys(dependencies).every(name => !name.startsWith('@aily-project/board-') || isSupportedRobotDevice(name));
}

export function loadRobotDeviceCatalog(): RobotDevice[] {
  const paths = window['path'];
  const files = window['fs'];
  const childPath = paths?.getAilyChildPath?.();
  if (!childPath || !files) {
    throw new Error('RobotSTEM device resources require the desktop application.');
  }
  const sourcePath = paths.join(childPath, 'boards', 'board-crazyflie');
  const packagePath = paths.join(sourcePath, 'package.json');
  const templatePath = paths.join(sourcePath, 'template', 'package.json');
  if (!paths.isExists(packagePath) || !paths.isExists(templatePath)) {
    throw new Error('RobotSTEM Crazyflie device package or project template is missing.');
  }
  const metadata: unknown = JSON.parse(files.readFileSync(packagePath, 'utf8'));
  if (!metadata || typeof metadata !== 'object' ||
      !('name' in metadata) || metadata.name !== CRAZYFLIE_DEVICE_PACKAGE ||
      !('version' in metadata) || typeof metadata.version !== 'string' || !metadata.version.trim()) {
    throw new Error('RobotSTEM Crazyflie device package metadata is invalid.');
  }
  if (!isSupportedRobotProject(JSON.parse(files.readFileSync(templatePath, 'utf8')))) {
    throw new Error('RobotSTEM Crazyflie project template is invalid.');
  }
  const image = paths.join(sourcePath, 'crazyflie2.1.png');
  return [{
    name: metadata.name,
    nickname: 'Crazyflie',
    version: metadata.version,
    img: '',
    imgLocalPath: paths.isExists(image) ? image : undefined,
    description: 'Crazyflie · Crazyradio · Blockly · Python · 3D',
    url: 'https://www.bitcraze.io/documentation/',
    brand: 'bitcraze',
    type: 'crazyflie',
    mode: ['arduino'],
    sourcePath,
  }];
}

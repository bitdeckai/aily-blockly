import * as Blockly from 'blockly';
import { Order } from 'blockly/python';

export const CRAZYFLIE_FLIGHT_COLOUR = '#4a87c6';
export const CRAZYFLIE_BASIC_FLIGHT_TYPES: readonly string[] = [
  'cf_crazyflie_link', 'cf_test_crazyflie_link', 'cf_takeoff', 'cf_land',
];

export type MotionKind = 'takeoff' | 'land' | 'move' | 'turn' | 'circle' | 'hover';
export interface MotionCommand {
  kind: MotionKind;
  values: number[];
}

interface MotionBlock {
  type: string;
  kind: MotionKind;
  en: string;
  zh: string;
  inputs: Array<{ name: string; value: number }>;
  direction?: Array<[string, string]>;
}

export const motionBlocks: MotionBlock[] = [
  {
    type: 'cf_takeoff_at', kind: 'takeoff',
    en: 'take off to %1 m at %2 m/s', zh: '起飞至 %1 米 速度 %2 米/秒',
    inputs: [{ name: 'HEIGHT', value: 0.5 }, { name: 'SPEED', value: 0.2 }],
  },
  {
    type: 'cf_land_at_speed', kind: 'land',
    en: 'land at %1 m/s', zh: '降落 速度 %1 米/秒',
    inputs: [{ name: 'SPEED', value: 0.2 }],
  },
  {
    type: 'cf_move_at_speed', kind: 'move',
    en: 'move %1 distance %2 m at %3 m/s', zh: '向 %1 移动 %2 米 速度 %3 米/秒',
    inputs: [{ name: 'DISTANCE', value: 0.3 }, { name: 'SPEED', value: 0.2 }],
    direction: [['forward', 'forward'], ['back', 'back'], ['left', 'left'], ['right', 'right'], ['up', 'up'], ['down', 'down']],
  },
  {
    type: 'cf_turn', kind: 'turn',
    en: 'turn %1 by %2 degrees at %3 degrees/s', zh: '向 %1 转向 %2 度 角速度 %3 度/秒',
    inputs: [{ name: 'ANGLE', value: 90 }, { name: 'RATE', value: 45 }],
    direction: [['left', 'left'], ['right', 'right']],
  },
  {
    type: 'cf_circle', kind: 'circle',
    en: 'arc %1 radius %2 m angle %3 degrees at %4 m/s', zh: '向 %1 绕圆 半径 %2 米 角度 %3 度 速度 %4 米/秒',
    inputs: [{ name: 'RADIUS', value: 0.5 }, { name: 'ANGLE', value: 90 }, { name: 'SPEED', value: 0.2 }],
    direction: [['left', 'left'], ['right', 'right']],
  },
  {
    type: 'cf_move_xyz', kind: 'move',
    en: 'move body X %1 Y %2 Z %3 m at %4 m/s',
    zh: '机体坐标移动 X %1 Y %2 Z %3 米 速度 %4 米/秒',
    inputs: [{ name: 'X', value: 0.3 }, { name: 'Y', value: 0 }, { name: 'Z', value: 0 }, { name: 'SPEED', value: 0.2 }],
  },
  {
    type: 'cf_hover', kind: 'hover', en: 'hover for %1 seconds', zh: '悬停 %1 秒',
    inputs: [{ name: 'SECONDS', value: 1 }],
  },
  {
    type: 'cf_stop_motion', kind: 'hover', en: 'stop moving and hover', zh: '停止移动并悬停',
    inputs: [],
  },
];

export function validateMotionCommand(kind: unknown, values: unknown): MotionCommand {
  const lengths: Record<MotionKind, number> = { takeoff: 2, land: 1, move: 4, turn: 2, circle: 3, hover: 1 };
  if (typeof kind !== 'string' || !Object.prototype.hasOwnProperty.call(lengths, kind)
    || !Array.isArray(values) || values.some(n => typeof n !== 'number' || !Number.isFinite(n))) {
    throw new Error('Crazyflie：运动指令类型或参数无效');
  }
  const commandKind = kind as MotionKind;
  if (values.length !== lengths[commandKind]) {
    throw new Error(`Crazyflie：${kind} 参数数量错误`);
  }
  const positive = commandKind === 'takeoff' ? [0, 1] : commandKind === 'land' ? [0]
    : commandKind === 'move' ? [3] : commandKind === 'turn' ? [1] : commandKind === 'circle' ? [0, 2] : [];
  if (positive.some(index => values[index] <= 0) || (commandKind === 'hover' && values[0] < 0)) {
    throw new Error('Crazyflie：高度、半径和速度必须大于 0，悬停时间不能小于 0');
  }
  const command = { kind: commandKind, values };
  motionDurationSeconds(command);
  return command;
}

export function motionDurationSeconds(command: MotionCommand, height = 0): number {
  const values = command.values;
  let duration: number;
  switch (command.kind) {
    case 'takeoff': duration = values[0] / values[1]; break;
    case 'land': duration = Math.max(0, height) / values[0]; break;
    case 'move': duration = Math.hypot(...values.slice(0, 3)) / values[3]; break;
    case 'turn': duration = Math.abs(values[0]) / values[1]; break;
    case 'circle': duration = values[0] * (Math.abs(values[1]) * Math.PI / 180) / values[2]; break;
    case 'hover': duration = values[0]; break;
  }
  if (!Number.isFinite(duration)) throw new Error('Crazyflie：运动持续时间超出数值范围');
  return duration;
}

export function motionFlowTimeoutMs(code: string): number {
  let height = 0;
  let duration = 0;
  for (const raw of code.split(/\r?\n/)) {
    const line = raw.trim();
    const command = parseMotionCall(line);
    if (command) {
      duration += motionDurationSeconds(command, height);
      if (command.kind === 'takeoff') height = command.values[0];
      if (command.kind === 'land') height = 0;
      if (command.kind === 'move') height += command.values[2];
    } else if (/^cf_takeoff\s*\(/.test(line)) {
      height = 0.3;
    } else if (/^cf_land\s*\(/.test(line)) {
      height = 0;
    } else {
      const delay = /^cf_delay\(\s*([0-9.e+-]+)\s*\)/i.exec(line);
      if (delay) duration += Number(delay[1]);
      const vertical = /^cf_move\(\s*['"](up|down)['"]\s*,\s*([0-9.e+-]+)/i.exec(line);
      if (vertical) height += Number(vertical[2]) * (vertical[1] === 'up' ? 1 : -1);
    }
  }
  // Keep the existing minute for connection/legacy operations, and allow the
  // new blocking maneuvers plus landing cleanup to complete before IPC timeout.
  const timeout = 60000 + Math.ceil(duration * 1000);
  if (!Number.isFinite(timeout) || timeout > 2147480000) {
    throw new Error('Crazyflie：流程时长超过进程计时器支持范围');
  }
  return timeout;
}

export function motionBlockCommand(block: Blockly.Block, input: (name: string, fallback: number) => number): MotionCommand {
  const spec = motionBlocks.find(item => item.type === block.type);
  if (!spec) throw new Error(`Crazyflie：未知运动积木 ${block.type}`);
  let values = spec.inputs.map(item => input(item.name, item.value));
  const direction = block.getFieldValue('DIRECTION');
  if (block.type === 'cf_move_at_speed') {
    const [distance, speed] = values;
    if (distance < 0) throw new Error('Crazyflie：移动距离不能小于 0，请用方向选择');
    const axes: Record<string, number[]> = {
      forward: [distance, 0, 0], back: [-distance, 0, 0], left: [0, distance, 0],
      right: [0, -distance, 0], up: [0, 0, distance], down: [0, 0, -distance],
    };
    if (!axes[direction]) throw new Error('Crazyflie：移动方向无效');
    values = [...axes[direction], speed];
  } else if (spec.direction) {
    const index = block.type === 'cf_circle' ? 1 : 0;
    if (values[index] < 0) throw new Error('Crazyflie：角度不能小于 0，请用方向选择');
    if (direction !== 'left' && direction !== 'right') throw new Error('Crazyflie：转向方向无效');
    values[index] *= direction === 'right' ? -1 : 1;
  }
  if (block.type === 'cf_stop_motion') values = [0];
  return validateMotionCommand(spec.kind, values);
}

export function emitMotionCommand(command: MotionCommand): string {
  return `cf_motion(${JSON.stringify(command.kind)}, ${JSON.stringify(command.values)})\n`;
}

export function parseMotionCall(line: string): MotionCommand | null {
  if (!/^cf_motion\b/.test(line)) return null;
  const match = /^cf_motion\(\s*("(?:[^"\\]|\\.)*")\s*,\s*(\[[^\]]*\])\s*\)\s*;?$/.exec(line);
  if (!match) throw new Error('Crazyflie：运动指令格式无效');
  return validateMotionCommand(JSON.parse(match[1]), JSON.parse(match[2]));
}

export function validateMotionSequence(commands: Array<{ type: string; value?: unknown }>): void {
  if (!commands.some(command => command.type === 'motion')) return;
  let flying = false;
  for (const command of commands) {
    const motion = command.type === 'motion' ? command.value as MotionCommand : null;
    const kind = motion?.kind || command.type;
    if (!['takeoff', 'land', 'move', 'turn', 'circle', 'hover'].includes(kind)) continue;
    if (kind === 'takeoff') {
      if (flying) throw new Error('Crazyflie：已经起飞，请勿重复起飞');
      flying = true;
    } else {
      if (!flying) throw new Error('Crazyflie：请先使用起飞积木再移动、转向、悬停或降落');
      if (kind === 'land') flying = false;
    }
  }
}

export function registerCrazyflieMotionBlocks(generator: Blockly.CodeGenerator, chinese: boolean): void {
  const labels: Record<string, string> = { forward: '前', back: '后', left: '左', right: '右', up: '上', down: '下' };
  for (const spec of motionBlocks) {
    const args: Array<object> = [];
    if (spec.direction) {
      args.push({ type: 'field_dropdown', name: 'DIRECTION', options: spec.direction.map(([label, value]) =>
        [chinese ? labels[value] : label, value]) });
    }
    args.push(...spec.inputs.map(item => ({ type: 'input_value', name: item.name, check: 'Number' })));
    Blockly.defineBlocksWithJsonArray([{
      type: spec.type, message0: chinese ? spec.zh : spec.en, args0: args,
      previousStatement: null, nextStatement: null, colour: CRAZYFLIE_FLIGHT_COLOUR,
      tooltip: chinese
        ? '需定位甲板；先连接再起飞。机体坐标 X 向前、Y 向左、Z 向上；悬停不会关闭电机。'
        : 'Requires positioning. Connect then take off. Body X forward, Y left, Z up. Hover does not turn off motors.',
    }]);
    generator.forBlock[spec.type] = (block, gen) => {
      const code = spec.inputs.map(item => gen.valueToCode(block, item.name, Order.NONE) || String(item.value));
      // Numeric blocks can be generated directly; expressions are resolved by
      // compileCrazyflieFlow before either flight runner receives the command.
      const literal = code.every(value => Number.isFinite(Number(value)));
      if (literal) {
        return emitMotionCommand(motionBlockCommand(block, name => Number(code[spec.inputs.findIndex(item => item.name === name)])));
      }
      if (spec.type === 'cf_move_at_speed') {
        const direction = block.getFieldValue('DIRECTION');
        const components: Record<string, string[]> = {
          forward: [code[0], '0', '0'], back: [`-(${code[0]})`, '0', '0'],
          left: ['0', code[0], '0'], right: ['0', `-(${code[0]})`, '0'],
          up: ['0', '0', code[0]], down: ['0', '0', `-(${code[0]})`],
        };
        return `cf_motion("move", [${[...components[direction], code[1]].join(', ')}])\n`;
      }
      if (spec.direction && block.getFieldValue('DIRECTION') === 'right') {
        const index = spec.type === 'cf_circle' ? 1 : 0;
        code[index] = `-(${code[index]})`;
      }
      return `cf_motion("${spec.kind}", [${code.join(', ')}])\n`;
    };
  }
}

export function createCrazyflieMotionToolbox(chinese: boolean) {
  return {
    kind: 'category', name: 'Crazyflie',
    categoryId: 'crazyflie-motion', icon: 'fa-light fa-drone-front', colour: CRAZYFLIE_FLIGHT_COLOUR,
    contents: motionBlocks.map(spec => ({
      kind: 'block', type: spec.type,
      inputs: Object.fromEntries(spec.inputs.map(item => [
        item.name, { shadow: { type: 'math_number', fields: { NUM: item.value } } },
      ])),
    })),
  };
}

export interface CrazyflieToolboxItem {
  kind: string;
  type?: string;
  name?: string;
  categoryId?: string;
  ailyLibraryName?: string;
  contents?: CrazyflieToolboxItem[];
  [key: string]: unknown;
}

export function isCrazyflieFlightToolbox(item: CrazyflieToolboxItem): boolean {
  return item.categoryId === 'crazyflie-motion'
    || item.ailyLibraryName === '@aily-project/lib-crazyflie-motion'
    || item.name === 'Crazyflie';
}

export function mergeCrazyflieFlightToolbox(
  incoming: CrazyflieToolboxItem, existing?: CrazyflieToolboxItem,
): CrazyflieToolboxItem {
  const hidden = new Set(['cf_delay', 'cf_print_text', 'cf_print', 'cf_test_link',
    'cf_link_config', 'cf_scan_links', 'cf_radio_config']);
  const clean = (items: CrazyflieToolboxItem[]): CrazyflieToolboxItem[] => {
    const seen = new Set<string>();
    return items.filter(item => {
      if (item.type && hidden.has(item.type)) return false;
      const key = item.type || (item.kind === 'category' ? item.name : undefined);
      if (key && seen.has(key)) return false;
      if (key) seen.add(key);
      return true;
    }).map(item => item.contents ? { ...item, contents: clean(item.contents) } : item)
      .filter(item => item.kind !== 'category' || !item.contents || item.contents.length > 0);
  };
  const contents = clean([
    ...(incoming.contents || []), ...(existing?.contents || []),
    ...createCrazyflieMotionToolbox(true).contents,
  ]);
  const priority = (item: CrazyflieToolboxItem): number => {
    const index = item.type ? CRAZYFLIE_BASIC_FLIGHT_TYPES.indexOf(item.type) : -1;
    return index < 0 ? CRAZYFLIE_BASIC_FLIGHT_TYPES.length : index;
  };
  contents.sort((a, b) => priority(a) - priority(b));
  return {
    ...existing, ...incoming, name: 'Crazyflie', categoryId: 'crazyflie-motion',
    colour: CRAZYFLIE_FLIGHT_COLOUR, contents,
  };
}

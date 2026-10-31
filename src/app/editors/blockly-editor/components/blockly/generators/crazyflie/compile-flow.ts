import * as Blockly from 'blockly';
import { crazyflieBasicBlockTypes } from './basic-blocks';
import { emitMotionCommand, motionBlockCommand, motionBlocks, parseMotionCall, validateMotionSequence } from './motion-blocks';
import { validateRadioScanCode } from './radio-blocks';
import { emitAiDeckCameraConfig } from './ai-deck-blocks';
import { validateAiDeckCameraSequence } from '../../../../../../services/ai-deck-camera';
import { validateCameraGestureProgram } from '../../../../../../services/camera-gesture';

type Value = number | string | boolean | null;
type Flow = 'break' | 'continue' | undefined;

// The flight runners accept literal cf_* calls, not arbitrary Python. Resolve
// basic control flow once so simulation and real flight use the same plan.
export function compileCrazyflieFlow(
  workspace: Blockly.Workspace,
  generator: Blockly.CodeGenerator,
  onCommand?: (block: Blockly.Block) => void,
): string {
  if (!workspace.getAllBlocks(false).some(block =>
    crazyflieBasicBlockTypes.includes(block.type) || block.type === 'cf_core_delay'
      || block.type.startsWith('cf_ai_deck_')
      || block.type.startsWith('cf_camera_gesture_')
      || motionBlocks.some(spec => spec.type === block.type))) {
    const code = generator.workspaceToCode(workspace);
    validateRadioScanCode(code);
    validateAiDeckCameraSequence(code);
    validateCameraGestureProgram(code);
    return code;
  }

  const variables = new Map<string, Value>();
  const output: string[] = [];
  let eventBlockIds: string[] | null = null;
  const recordCommand = (block: Blockly.Block) => {
    if (eventBlockIds) eventBlockIds.push(block.id);
    else onCommand?.(block);
  };
  let remaining = 10000;
  const tick = () => {
    if (--remaining < 0) {
      throw new Error('Crazyflie：基础积木执行超过 10000 步，请检查循环是否能结束');
    }
  };
  const fail = (block: Blockly.Block): never => {
    throw new Error(`Crazyflie：基础流程暂不支持积木 ${block.type}，请勿在条件中使用实时传感器读数`);
  };
  const variableId = (block: Blockly.Block) => String(block.getFieldValue('VAR'));
  const numeric = (value: Value): number => {
    const result = Number(value);
    if (!Number.isFinite(result)) {
      throw new Error('Crazyflie：基础积木计算结果必须是有限数值');
    }
    return result;
  };
  const text = (value: Value): string =>
    value === null ? 'None' : typeof value === 'boolean' ? (value ? 'True' : 'False') : String(value);
  const input = (block: Blockly.Block, name: string, fallback: Value = 0): Value => {
    const child = block.getInputTargetBlock(name);
    return child?.isEnabled() ? evaluate(child) : fallback;
  };
  const evaluate = (block: Blockly.Block): Value => {
    tick();
    switch (block.type) {
      case 'math_number': return numeric(block.getFieldValue('NUM'));
      case 'text': return String(block.getFieldValue('TEXT'));
      case 'logic_boolean': return block.getFieldValue('BOOL') === 'TRUE';
      case 'logic_null': return null;
      case 'variables_get': return variables.get(variableId(block)) ?? 0;
      case 'logic_negate': return !input(block, 'BOOL', false);
      case 'logic_ternary':
        return input(block, 'IF', false) ? input(block, 'THEN', null) : input(block, 'ELSE', null);
      case 'logic_operation':
        return block.getFieldValue('OP') === 'AND'
          ? Boolean(input(block, 'A', false) && input(block, 'B', false))
          : Boolean(input(block, 'A', false) || input(block, 'B', false));
      case 'logic_compare': {
        const a = input(block, 'A');
        const b = input(block, 'B');
        const equal = a === b || (typeof a === 'boolean' && typeof b === 'number' && Number(a) === b)
          || (typeof b === 'boolean' && typeof a === 'number' && a === Number(b));
        const compare = (operator: 'LT' | 'LTE' | 'GT' | 'GTE'): boolean => {
          if (a === null || b === null || ((typeof a === 'string') !== (typeof b === 'string'))) {
            return fail(block);
          }
          const left = typeof a === 'string' && typeof b === 'string' ? a : numeric(a);
          const right = typeof a === 'string' && typeof b === 'string' ? b : numeric(b);
          switch (operator) {
            case 'LT': return left < right;
            case 'LTE': return left <= right;
            case 'GT': return left > right;
            case 'GTE': return left >= right;
          }
        };
        switch (block.getFieldValue('OP')) {
          case 'EQ': return equal;
          case 'NEQ': return !equal;
          case 'LT': return compare('LT');
          case 'LTE': return compare('LTE');
          case 'GT': return compare('GT');
          case 'GTE': return compare('GTE');
          default: return fail(block);
        }
      }
      case 'math_arithmetic': {
        const a = numeric(input(block, 'A'));
        const b = numeric(input(block, 'B'));
        switch (block.getFieldValue('OP')) {
          case 'ADD': return numeric(a + b);
          case 'MINUS': return numeric(a - b);
          case 'MULTIPLY': return numeric(a * b);
          case 'DIVIDE': return numeric(a / b);
          case 'POWER': return numeric(a ** b);
          default: return fail(block);
        }
      }
      case 'math_single': {
        const n = numeric(input(block, 'NUM'));
        switch (block.getFieldValue('OP')) {
          case 'ROOT': return numeric(Math.sqrt(n));
          case 'ABS': return Math.abs(n);
          case 'NEG': return -n;
          case 'LN': return numeric(Math.log(n));
          case 'LOG10': return numeric(Math.log10(n));
          case 'EXP': return numeric(Math.exp(n));
          case 'POW10': return numeric(10 ** n);
          default: return fail(block);
        }
      }
      case 'math_round': {
        const n = numeric(input(block, 'NUM'));
        switch (block.getFieldValue('OP')) {
          case 'ROUND': {
            const floor = Math.floor(n);
            return n - floor === 0.5 ? (floor % 2 === 0 ? floor : floor + 1) : Math.round(n);
          }
          case 'ROUNDUP': return Math.ceil(n);
          case 'ROUNDDOWN': return Math.floor(n);
          default: return fail(block);
        }
      }
      case 'math_modulo': {
        const a = numeric(input(block, 'DIVIDEND'));
        const b = numeric(input(block, 'DIVISOR'));
        return numeric(((a % b) + b) % b);
      }
      case 'math_constrain':
        return Math.min(Math.max(numeric(input(block, 'VALUE')), numeric(input(block, 'LOW'))),
          numeric(input(block, 'HIGH', Number.MAX_VALUE)));
      case 'text_join': {
        let result = '';
        for (let i = 0; block.getInput(`ADD${i}`); i++) {
          result += text(input(block, `ADD${i}`, ''));
          if (result.length > 100000) {
            throw new Error('Crazyflie：文字长度不能超过 100000 个字符');
          }
        }
        return result;
      }
      case 'text_length': return Array.from(text(input(block, 'VALUE', ''))).length;
      case 'text_isEmpty': return text(input(block, 'VALUE', '')).length === 0;
      default: return fail(block);
    }
  };
  const run = (first: Blockly.Block | null, inLoop = false): Flow => {
    for (let block = first; block; block = block.getNextBlock()) {
      tick();
      if (!block.isEnabled()) {
        continue;
      }
      switch (block.type) {
        case 'cf_ai_deck_config': {
          const address = input(block, 'ADDRESS', '');
          if (typeof address !== 'string') return fail(block);
          output.push(emitAiDeckCameraConfig(address));
          recordCommand(block);
          break;
        }
        case 'cf_camera_gesture_on': {
          if (eventBlockIds || inLoop) throw new Error('CAMERA_GESTURE.INVALID_PROGRAM');
          const start = output.length;
          const savedVariables = new Map(variables);
          eventBlockIds = [];
          run(block.getInputTargetBlock('DO'));
          const code = output.splice(start).join('\n');
          const blockIds = eventBlockIds;
          eventBlockIds = null;
          variables.clear();
          savedVariables.forEach((value, key) => variables.set(key, value));
          const binding = { gesture: block.getFieldValue('GESTURE'), holdSeconds: Number(block.getFieldValue('HOLD')), code, blockIds };
          output.push(`cf_camera_gesture_on(${JSON.stringify(binding)})`);
          recordCommand(block);
          break;
        }
        case 'variables_set':
          variables.set(variableId(block), input(block, 'VALUE'));
          break;
        case 'math_change':
          variables.set(variableId(block), numeric(numeric(variables.get(variableId(block)) ?? 0) + numeric(input(block, 'DELTA'))));
          break;
        case 'controls_if': {
          let matched = false;
          for (let n = 0; block.getInput(`IF${n}`); n++) {
            if (input(block, `IF${n}`, false)) {
              matched = true;
              const flow = run(block.getInputTargetBlock(`DO${n}`), inLoop);
              if (flow) return flow;
              break;
            }
          }
          if (!matched) {
            const flow = run(block.getInputTargetBlock('ELSE'), inLoop);
            if (flow) return flow;
          }
          break;
        }
        case 'controls_repeat_ext': {
          const times = Math.max(0, Math.floor(numeric(input(block, 'TIMES'))));
          for (let i = 0; i < times; i++) {
            tick();
            if (run(block.getInputTargetBlock('DO'), true) === 'break') break;
          }
          break;
        }
        case 'controls_for': {
          const from = numeric(input(block, 'FROM'));
          const to = numeric(input(block, 'TO'));
          const step = Math.abs(numeric(input(block, 'BY', 1)));
          if (!step) throw new Error('Crazyflie：计数循环的步长不能为 0');
          const direction = from <= to ? 1 : -1;
          for (let i = from; direction > 0 ? i <= to : i >= to; i += direction * step) {
            tick();
            variables.set(variableId(block), i);
            if (run(block.getInputTargetBlock('DO'), true) === 'break') break;
          }
          break;
        }
        case 'controls_whileUntil':
          while (Boolean(input(block, 'BOOL', false)) === (block.getFieldValue('MODE') === 'WHILE')) {
            tick();
            if (run(block.getInputTargetBlock('DO'), true) === 'break') break;
          }
          break;
        case 'controls_flow_statements':
          if (!inLoop) throw new Error('Crazyflie：跳出/继续积木必须放在循环内');
          return block.getFieldValue('FLOW') === 'BREAK' ? 'break' : 'continue';
        case 'cf_core_delay': {
          const seconds = numeric(input(block, 'SECONDS'));
          if (seconds < 0) throw new Error('Crazyflie：等待秒数不能小于 0');
          output.push(`cf_delay(${seconds.toFixed(6)})`);
          recordCommand(block);
          break;
        }
        case 'text_print':
          output.push(`cf_print(${JSON.stringify(text(input(block, 'TEXT', '')))})`);
          recordCommand(block);
          break;
        case 'cf_print':
          output.push(`cf_print(${JSON.stringify(text(input(block, 'VALUE', '')))})`);
          recordCommand(block);
          break;
        default:
          if (motionBlocks.some(spec => spec.type === block.type)) {
            output.push(emitMotionCommand(motionBlockCommand(block, (name, fallback) => numeric(input(block, name, fallback)))));
            recordCommand(block);
          } else if (block.outputConnection) {
            evaluate(block);
          } else if (block.type.startsWith('cf_')) {
            const code = generator.blockToCode(block, true);
            if (typeof code !== 'string') return fail(block);
            output.push(code);
            recordCommand(block);
          } else {
            fail(block);
          }
      }
    }
    return undefined;
  };

  generator.init(workspace);
  try {
    for (const block of workspace.getTopBlocks(true)) {
      if (!block.isShadow()) run(block);
    }
    const code = output.join('\n');
    validateRadioScanCode(code);
    validateAiDeckCameraSequence(code);
    validateCameraGestureProgram(code);
    validateMotionSequence(code.split(/\r?\n/).map(line => {
      const motion = parseMotionCall(line);
      if (motion) return { type: 'motion', value: motion };
      if (/^cf_crazyflie_link\s*\(/.test(line)) return { type: 'crazyflie_link' };
      if (/^cf_takeoff\s*\(/.test(line)) return { type: 'takeoff' };
      if (/^cf_land\s*\(/.test(line)) return { type: 'land' };
      if (/^cf_move\s*\(/.test(line)) return { type: 'move' };
      return { type: 'other' };
    }));
    return code;
  } finally {
    generator.finish('');
  }
}

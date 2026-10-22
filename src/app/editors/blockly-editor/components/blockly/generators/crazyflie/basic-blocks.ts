import * as Blockly from 'blockly';
import { blocks } from 'blockly/blocks';
import { Order, PythonGenerator, pythonGenerator } from 'blockly/python';

export const crazyflieGenerator = new PythonGenerator('Crazyflie');
Object.assign(crazyflieGenerator.forBlock, pythonGenerator.forBlock);
crazyflieGenerator.forBlock['text_print'] = (block, generator) =>
  `cf_print(${generator.valueToCode(block, 'TEXT', Order.NONE) || "''"})\n`;
crazyflieGenerator.forBlock['cf_core_delay'] = (block, generator) =>
  `cf_delay(${generator.valueToCode(block, 'SECONDS', Order.NONE) || '0'})\n`;

export const crazyflieBasicBlockTypes = [
  'controls_if', 'logic_compare', 'logic_operation', 'logic_negate', 'logic_boolean',
  'logic_null', 'logic_ternary', 'controls_repeat_ext', 'controls_for',
  'controls_whileUntil', 'controls_flow_statements', 'math_number', 'math_arithmetic',
  'math_single', 'math_round', 'math_modulo', 'math_constrain', 'text', 'text_join',
  'text_length', 'text_isEmpty', 'text_print', 'variables_get', 'variables_set', 'math_change',
];

export function registerCrazyflieBasicBlocks(): void {
  for (const type of crazyflieBasicBlockTypes) {
    Blockly.Blocks[type] = blocks[type];
  }
  Blockly.defineBlocksWithJsonArray([{
    type: 'cf_core_delay',
    message0: '%{BKY_CONTROLS_WAIT_SECONDS}',
    args0: [{ type: 'input_value', name: 'SECONDS', check: 'Number' }],
    previousStatement: null,
    nextStatement: null,
    colour: '#5ba5a5',
    tooltip: '%{BKY_CONTROLS_WAIT_SECONDS_TOOLTIP}',
  }]);
}

export function createCrazyflieBasicToolbox(chinese: boolean) {
  Blockly.Msg['CONTROLS_WAIT_SECONDS'] = chinese ? '等待 %1 秒' : 'wait %1 seconds';
  Blockly.Msg['CONTROLS_WAIT_SECONDS_TOOLTIP'] = chinese ? '等待指定秒数后继续执行' : 'Wait before continuing';
  const block = (type: string): Blockly.utils.toolbox.BlockInfo => ({ kind: 'block', type });
  const number = (value: number) => ({ shadow: { type: 'math_number', fields: { NUM: value } } });
  const category = (id: string, name: string, icon: string, colour: string, types: string[]) => ({
    kind: 'category',
    categoryId: `crazyflie-basic-${id}`,
    name,
    icon: `fa-light ${icon}`,
    colour,
    contents: types.map(block),
  });
  const loops = category('loops', chinese ? '循环' : 'Loops', 'fa-repeat', '#5ba55b',
    ['controls_repeat_ext', 'controls_for', 'controls_whileUntil', 'controls_flow_statements']);
  loops.contents[0].inputs = { TIMES: number(3) };
  loops.contents[1].inputs = { FROM: number(1), TO: number(5), BY: number(1) };
  return [
    category('logic', chinese ? '逻辑' : 'Logic', 'fa-code-branch', '#5b80a5',
      ['controls_if', 'logic_compare', 'logic_operation', 'logic_negate', 'logic_boolean', 'logic_null', 'logic_ternary']),
    loops,
    category('math', chinese ? '数学' : 'Math', 'fa-calculator', '#5b67a5',
      ['math_number', 'math_arithmetic', 'math_single', 'math_round', 'math_modulo', 'math_constrain']),
    category('text', chinese ? '文字' : 'Text', 'fa-font', '#5ba58c',
      ['text', 'text_join', 'text_length', 'text_isEmpty', 'text_print']),
    {
      ...category('time', chinese ? '时间' : 'Time', 'fa-clock', '#5ba5a5', ['cf_core_delay']),
      contents: [{ ...block('cf_core_delay'), inputs: { SECONDS: number(1) } }],
    },
    {
      ...category('variables', chinese ? '变量' : 'Variables', 'fa-xmark', '#a55b80', []),
      custom: 'VARIABLE',
    },
  ];
}

import type * as Blockly from 'blockly';

export const CRAZYFLIE_EXAMPLES = [
  { id: 'self-test', titleKey: 'CRAZYFLIE_EXAMPLES.SELF_TEST', descriptionKey: 'CRAZYFLIE_EXAMPLES.SELF_TEST_DESCRIPTION' },
  { id: 'hover', titleKey: 'CRAZYFLIE_EXAMPLES.HOVER', descriptionKey: 'CRAZYFLIE_EXAMPLES.HOVER_DESCRIPTION' },
  { id: 'back-and-forth', titleKey: 'CRAZYFLIE_EXAMPLES.BACK_AND_FORTH', descriptionKey: 'CRAZYFLIE_EXAMPLES.BACK_AND_FORTH_DESCRIPTION' },
  { id: 'square', titleKey: 'CRAZYFLIE_EXAMPLES.SQUARE', descriptionKey: 'CRAZYFLIE_EXAMPLES.SQUARE_DESCRIPTION' },
] as const;

export type CrazyflieExampleId = typeof CRAZYFLIE_EXAMPLES[number]['id'];

export function createCrazyflieExample(id: CrazyflieExampleId): Blockly.serialization.blocks.State {
  type State = Blockly.serialization.blocks.State;
  const number = (value: number) => ({ shadow: { type: 'math_number', fields: { NUM: value } } });
  const wait = (seconds: number): State => ({ type: 'cf_core_delay', inputs: { SECONDS: number(seconds) } });
  const link: State = { type: 'cf_crazyflie_link' };
  const takeoff: State = { type: 'cf_takeoff_at', inputs: { HEIGHT: number(0.3), SPEED: number(0.2) } };
  const land: State = { type: 'cf_land_at_speed', inputs: { SPEED: number(0.2) } };
  const move = (direction: string): State => ({
    type: 'cf_move_at_speed', fields: { DIRECTION: direction },
    inputs: { DISTANCE: number(0.3), SPEED: number(0.2) },
  });
  let blocks: [State, ...State[]];
  switch (id) {
    case 'self-test':
      blocks = [{ type: 'cf_test_link' }, wait(2), link, wait(2), { type: 'cf_test_crazyflie_link' }, wait(3)];
      break;
    case 'hover':
      blocks = [link, wait(2), takeoff, wait(3), land, wait(2)];
      break;
    case 'back-and-forth':
      blocks = [link, wait(2), takeoff, wait(2), move('forward'), wait(1), move('back'), wait(1), land, wait(2)];
      break;
    case 'square':
      blocks = [link, wait(2), takeoff, wait(2), move('forward'), wait(1), move('left'), wait(1),
        move('back'), wait(1), move('right'), wait(1), land, wait(2)];
      break;
    default:
      throw new Error(`Unknown Crazyflie example: ${id}`);
  }
  const [first, ...rest] = blocks;
  let tail = first;
  for (const block of rest) {
    tail.next = { block };
    tail = block;
  }
  first.x = 80;
  first.y = 80;
  return first;
}

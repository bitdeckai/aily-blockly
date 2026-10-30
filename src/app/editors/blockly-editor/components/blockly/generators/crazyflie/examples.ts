import type * as Blockly from 'blockly';

export const CRAZYFLIE_EXAMPLES = [
  { id: 'self-test', titleKey: 'CRAZYFLIE_EXAMPLES.SELF_TEST', descriptionKey: 'CRAZYFLIE_EXAMPLES.SELF_TEST_DESCRIPTION', noticeKey: 'CRAZYFLIE_EXAMPLES.SELF_TEST_NOTICE' },
  { id: 'hover', titleKey: 'CRAZYFLIE_EXAMPLES.HOVER', descriptionKey: 'CRAZYFLIE_EXAMPLES.HOVER_DESCRIPTION', noticeKey: 'CRAZYFLIE_EXAMPLES.FLIGHT_NOTICE' },
  { id: 'back-and-forth', titleKey: 'CRAZYFLIE_EXAMPLES.BACK_AND_FORTH', descriptionKey: 'CRAZYFLIE_EXAMPLES.BACK_AND_FORTH_DESCRIPTION', noticeKey: 'CRAZYFLIE_EXAMPLES.FLIGHT_NOTICE' },
  { id: 'square', titleKey: 'CRAZYFLIE_EXAMPLES.SQUARE', descriptionKey: 'CRAZYFLIE_EXAMPLES.SQUARE_DESCRIPTION', noticeKey: 'CRAZYFLIE_EXAMPLES.FLIGHT_NOTICE' },
  { id: 'led-colors', titleKey: 'CRAZYFLIE_EXAMPLES.LED_COLORS', descriptionKey: 'CRAZYFLIE_EXAMPLES.LED_COLORS_DESCRIPTION', noticeKey: 'CRAZYFLIE_EXAMPLES.DECK_NOTICE' },
  { id: 'led-blink', titleKey: 'CRAZYFLIE_EXAMPLES.LED_BLINK', descriptionKey: 'CRAZYFLIE_EXAMPLES.LED_BLINK_DESCRIPTION', noticeKey: 'CRAZYFLIE_EXAMPLES.DECK_NOTICE' },
  { id: 'buzzer-rhythm', titleKey: 'CRAZYFLIE_EXAMPLES.BUZZER_RHYTHM', descriptionKey: 'CRAZYFLIE_EXAMPLES.BUZZER_RHYTHM_DESCRIPTION', noticeKey: 'CRAZYFLIE_EXAMPLES.DECK_NOTICE' },
  { id: 'range-monitor', titleKey: 'CRAZYFLIE_EXAMPLES.RANGE_MONITOR', descriptionKey: 'CRAZYFLIE_EXAMPLES.RANGE_MONITOR_DESCRIPTION', noticeKey: 'CRAZYFLIE_EXAMPLES.DECK_NOTICE' },
] as const;

export type CrazyflieExampleId = typeof CRAZYFLIE_EXAMPLES[number]['id'];

export function createCrazyflieExample(id: CrazyflieExampleId): Blockly.serialization.blocks.State {
  type State = Blockly.serialization.blocks.State;
  const number = (value: number) => ({ shadow: { type: 'math_number', fields: { NUM: value } } });
  const sequence = ([first, ...rest]: [State, ...State[]]): State => {
    let tail = first;
    for (const block of rest) {
      tail.next = { block };
      tail = block;
    }
    return first;
  };
  const repeat = (times: number, body: [State, ...State[]]): State => ({
    type: 'controls_repeat_ext', inputs: { TIMES: number(times), DO: { block: sequence(body) } },
  });
  const wait = (seconds: number): State => ({ type: 'cf_core_delay', inputs: { SECONDS: number(seconds) } });
  const color = (r: number, g: number, b: number): State => ({
    type: 'cf_led_ring_set_color', fields: { R: r, G: g, B: b },
  });
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
    case 'led-colors':
      blocks = [link, wait(2), { type: 'cf_detect_led_ring' }, wait(1),
        color(64, 0, 0), wait(1), color(0, 64, 0), wait(1), color(0, 0, 64), wait(1),
        { type: 'cf_led_ring_off' }];
      break;
    case 'led-blink':
      blocks = [link, wait(2), { type: 'cf_detect_led_ring' }, wait(1),
        repeat(3, [color(0, 0, 64), wait(0.5), { type: 'cf_led_ring_off' }, wait(0.5)])];
      break;
    case 'buzzer-rhythm':
      blocks = [link, wait(2), { type: 'cf_detect_buzzer' }, wait(1),
        { type: 'cf_buzzer_beep', fields: { DURATION: 120, TIMES: 3 } }, wait(1),
        { type: 'cf_buzzer_beep', fields: { DURATION: 300, TIMES: 1 } }, wait(1)];
      break;
    case 'range-monitor':
      blocks = [link, wait(2), { type: 'cf_detect_multiranger' }, wait(1),
        repeat(5, [{ type: 'cf_mr_log_all_distances' }, wait(1)])];
      break;
    default:
      throw new Error(`Unknown Crazyflie example: ${id}`);
  }
  const first = sequence(blocks);
  first.x = 80;
  first.y = 80;
  return first;
}

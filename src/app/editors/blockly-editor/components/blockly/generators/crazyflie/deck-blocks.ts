import * as Blockly from 'blockly';
import type { CrazyflieToolboxItem } from './motion-blocks';

export const LED_RING_COLORS = [
  { value: 'red', en: 'Red', zh: '红色', rgb: [255, 0, 0] },
  { value: 'green', en: 'Green', zh: '绿色', rgb: [0, 255, 0] },
  { value: 'cyan', en: 'Cyan', zh: '青色', rgb: [0, 255, 255] },
  { value: 'blue', en: 'Blue', zh: '蓝色', rgb: [0, 0, 255] },
  { value: 'purple', en: 'Purple', zh: '紫色', rgb: [128, 0, 128] },
  { value: 'yellow', en: 'Yellow', zh: '黄色', rgb: [255, 255, 0] },
  { value: 'orange', en: 'Orange', zh: '橙色', rgb: [255, 128, 0] },
  { value: 'pink', en: 'Pink', zh: '粉色', rgb: [255, 105, 180] },
  { value: 'white', en: 'White', zh: '白色', rgb: [255, 255, 255] },
] as const;

export const BUZZER_SOUNDS = [
  { value: '6', en: 'Startup', zh: '启动提示' },
  { value: '4', en: 'Charging complete', zh: '完成提示' },
  { value: '7', en: 'Calibrated', zh: '校准提示' },
  { value: '2', en: 'USB connected', zh: 'USB 接入' },
  { value: '3', en: 'USB disconnected', zh: 'USB 拔出' },
] as const;

export function registerCrazyflieDeckBlocks(generator: Blockly.CodeGenerator, chinese: boolean): void {
  Blockly.defineBlocksWithJsonArray([{
    type: 'cf_led_ring_color', colour: 45,
    message0: chinese ? '设置灯环颜色 %1' : 'Set LED-ring color %1',
    args0: [{ type: 'field_dropdown', name: 'COLOR',
      options: LED_RING_COLORS.map(color => [chinese ? color.zh : color.en, color.value]) }],
    previousStatement: null, nextStatement: null,
    tooltip: chinese ? '选择常用灯环颜色；需要自定义亮度时使用红绿蓝数值积木。'
      : 'Choose a common color. Use the RGB block for custom brightness.',
  }, {
    type: 'cf_buzzer_play_sound', colour: 20,
    message0: chinese ? '蜂鸣器 播放 %1 最长 %2 毫秒' : 'Buzzer play %1 for up to %2 ms',
    args0: [
      { type: 'field_dropdown', name: 'SOUND',
        options: BUZZER_SOUNDS.map(sound => [chinese ? sound.zh : sound.en, sound.value]) },
      { type: 'field_number', name: 'DURATION', value: 1500, min: 100, max: 5000, precision: 1 },
    ],
    previousStatement: null, nextStatement: null,
    tooltip: chinese ? '播放固件内置提示音，到时或取消时停止；需要支持 sound.effect 的蜂鸣器固件。模拟只显示日志。'
      : 'Play a firmware system sound; stop at the time limit or on cancellation. Requires sound.effect support. Simulation logs only.',
  }]);
  generator.forBlock['cf_led_ring_color'] = block => {
    const color = LED_RING_COLORS.find(item => item.value === block.getFieldValue('COLOR'));
    if (!color) throw new Error('Unknown LED-ring color');
    return `cf_led_ring_set_color(${color.rgb.join(', ')})\n`;
  };
  generator.forBlock['cf_buzzer_play_sound'] = block => {
    const sound = BUZZER_SOUNDS.find(item => item.value === block.getFieldValue('SOUND'));
    const duration = Number(block.getFieldValue('DURATION'));
    if (!sound || !Number.isInteger(duration) || duration < 100 || duration > 5000) {
      throw new Error('Invalid buzzer sound or duration');
    }
    return `cf_buzzer_play_sound(${sound.value}, ${duration})\n`;
  };
}

export function mergeCrazyflieDeckToolbox(item: CrazyflieToolboxItem): CrazyflieToolboxItem {
  if (!item.contents) return item;
  const contents = item.contents.map(mergeCrazyflieDeckToolbox);
  for (const [anchor, type] of [
    ['cf_led_ring_set_color', 'cf_led_ring_color'],
    ['cf_buzzer_beep', 'cf_buzzer_play_sound'],
  ]) {
    const index = contents.findIndex(block => block.type === anchor);
    if (index >= 0 && !contents.some(block => block.type === type)) {
      contents.splice(index + 1, 0, { kind: 'block', type });
    }
  }
  return { ...item, contents };
}

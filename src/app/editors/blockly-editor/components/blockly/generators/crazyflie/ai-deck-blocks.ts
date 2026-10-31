import * as Blockly from 'blockly';
import { Order } from 'blockly/python';
import { aiDeckStreamUrl } from '../../../../../../services/ai-deck-camera';

export function registerAiDeckCameraBlocks(generator: Blockly.CodeGenerator, chinese: boolean): void {
  const colour = '#467b9e';
  Blockly.defineBlocksWithJsonArray([{
    type: 'cf_ai_deck_config',
    message0: chinese ? 'AI Deck 摄像头 配置地址 %1' : 'AI Deck camera set address %1',
    args0: [{ type: 'input_value', name: 'ADDRESS', check: 'String' }],
    previousStatement: null, nextStatement: null, colour,
    tooltip: chinese ? '填写 IP 或完整 HTTP(S) 视频流地址。只配置电脑端预览，不烧录或初始化引脚。'
      : 'Use a device IP or HTTP(S) stream URL. Configures the desktop viewer, not firmware or camera pins.',
  }, ...(['open', 'close'] as const).map(action => ({
    type: `cf_ai_deck_${action}`,
    message0: chinese ? `AI Deck 摄像头 ${action === 'open' ? '打开画面' : '关闭画面'}`
      : `AI Deck camera ${action === 'open' ? 'open video' : 'close video'}`,
    previousStatement: null, nextStatement: null, colour,
    tooltip: chinese ? '按程序顺序操作电脑端视频画面，所有运行模式均直接访问设备，不控制飞行。打开前先配置地址，可用等待积木保持画面。'
      : 'Controls device video in program order in all modes, independently of flight. Configure first; use a wait block to keep video open.',
  }))]);
  generator.forBlock['cf_ai_deck_config'] = (block, runtime) =>
    `cf_ai_deck_config(${runtime.valueToCode(block, 'ADDRESS', Order.NONE) || '""'})\n`;
  for (const action of ['open', 'close']) generator.forBlock[`cf_ai_deck_${action}`] = () => `cf_ai_deck_${action}()\n`;
}

export function emitAiDeckCameraConfig(address: string): string {
  aiDeckStreamUrl(address);
  return `cf_ai_deck_config(${JSON.stringify(address.trim())})\n`;
}

export function createAiDeckCameraToolbox() {
  return {
    kind: 'category', name: 'AI Deck', categoryId: 'crazyflie-ai-deck-camera',
    icon: 'fa-light fa-camera', colour: '#467b9e',
    contents: [
      { kind: 'block', type: 'cf_ai_deck_config', inputs: {
        ADDRESS: { shadow: { type: 'text', fields: { TEXT: '192.168.4.1' } } },
      } },
      { kind: 'block', type: 'cf_ai_deck_open' },
      { kind: 'block', type: 'cf_ai_deck_close' },
    ],
  };
}

import * as Blockly from 'blockly';
import { Order } from 'blockly/python';
import { aiDeckStreamUrl } from '../../../../../../services/ai-deck-camera';
import '../../custom-field/field-camera-preview';
import { CAMERA_GESTURES, isCameraGesture, isCameraSwipe } from '../../../../../../services/camera-gesture';
import { cameraGestureIllustration } from './gesture-illustrations';

export function registerAiDeckCameraBlocks(generator: Blockly.CodeGenerator, chinese: boolean): void {
  const colour = '#467b9e';
  Blockly.defineBlocksWithJsonArray([{
    type: 'cf_ai_deck_config',
    message0: chinese ? '摄像头 配置地址 %1' : 'Camera set address %1',
    args0: [{ type: 'input_value', name: 'ADDRESS', check: 'String' }],
    previousStatement: null, nextStatement: null, colour,
    tooltip: chinese ? '填写 IP 或完整 HTTP(S) 视频流地址。只配置电脑端预览，不烧录或初始化引脚。'
      : 'Use a device IP or HTTP(S) stream URL. Configures the desktop viewer, not firmware or camera pins.',
  }, ...(['open', 'close'] as const).map(action => ({
    type: `cf_ai_deck_${action}`,
    message0: chinese ? `摄像头 ${action === 'open' ? '打开画面' : '关闭画面'}`
      : `Camera ${action === 'open' ? 'open video' : 'close video'}`,
    ...(action === 'open' ? {
      message1: '%1',
      args1: [{ type: 'field_camera_preview', name: 'PREVIEW_WIDTH', width: 320 }],
    } : {}),
    previousStatement: null, nextStatement: null, colour,
    tooltip: chinese ? '按程序顺序操作电脑端视频画面，所有运行模式均直接访问设备，不控制飞行。打开前先配置地址，可用等待积木保持画面。'
      : 'Controls device video in program order in all modes, independently of flight. Configure first; use a wait block to keep video open.',
  }))]);
  generator.forBlock['cf_ai_deck_config'] = (block, runtime) =>
    `cf_ai_deck_config(${runtime.valueToCode(block, 'ADDRESS', Order.NONE) || '""'})\n`;
  for (const action of ['open', 'close']) generator.forBlock[`cf_ai_deck_${action}`] = () => `cf_ai_deck_${action}()\n`;
  const names = chinese
    ? ['张开手掌', '握拳', '食指指向', '竖起拇指', '拇指向下', '胜利手势', '我爱你手势',
      'OK 手势', '手掌向左滑动', '手掌向右滑动', '手掌向上滑动', '手掌向下滑动']
    : ['Open palm', 'Closed fist', 'Pointing / one', 'Thumb up', 'Thumb down', 'Victory', 'I love you',
      'OK sign', 'Palm swipe left', 'Palm swipe right', 'Palm swipe up', 'Palm swipe down'];
  const extension = 'cf_camera_gesture_illustration';
  if (Blockly.Extensions.isRegistered(extension)) Blockly.Extensions.unregister(extension);
  Blockly.Extensions.register(extension, function () {
    const dropdown = this.getField('GESTURE');
    const image = this.getField('ILLUSTRATION');
    const preparation = this.getField('PREPARATION');
    if (!(dropdown instanceof Blockly.FieldDropdown) || !(image instanceof Blockly.FieldImage) || !preparation) {
      throw new Error('Camera gesture illustration fields are missing');
    }
    dropdown.setValidator(value => {
      if (!isCameraGesture(value)) throw new Error('CAMERA_GESTURE.INVALID_PROGRAM');
      image.setValue(cameraGestureIllustration(value));
      image.setAlt(names[CAMERA_GESTURES.indexOf(value)]);
      preparation.setValue(isCameraSwipe(value) ? (chinese ? '先张手静止' : 'first hold palm still for') : (chinese ? '保持' : 'hold for'));
      this.setTooltip(isCameraSwipe(value)
        ? (chinese ? '先张开手掌静止保持指定时间，再在 1 秒内沿画面方向移动至少一掌宽。只产生事件，不定义飞行动作。再次触发前先放下手，摄像头应固定。'
          : 'Hold an open palm still first, then move at least one palm width within 1 second in the image direction. Emits events only. Release to retrigger; keep the camera fixed.')
        : (chinese ? '保持指定手势后只产生一次事件，动作由下面的积木定义。放下手后可再次触发。'
          : 'Holding this pose emits one event. Define actions below. Release your hand to retrigger.'));
      return value;
    });
  });
  Blockly.defineBlocksWithJsonArray([{
    type: 'cf_camera_gesture_on', colour,
    message0: chinese ? '当识别到 %1 %2 %3 %4 秒' : 'When gesture %1 %2 %3 %4 seconds',
    args0: [
      { type: 'field_image', name: 'ILLUSTRATION', src: cameraGestureIllustration('Open_Palm'), width: 48, height: 54, alt: names[0] },
      { type: 'field_dropdown', name: 'GESTURE', options: CAMERA_GESTURES.map((gesture, index) => [names[index], gesture]) },
      { type: 'field_label', name: 'PREPARATION', text: chinese ? '保持' : 'hold for' },
      { type: 'field_number', name: 'HOLD', value: 1.2, min: 0.5, max: 5, precision: 0.1 },
    ],
    extensions: [extension],
    message1: chinese ? '执行 %1' : 'do %1',
    args1: [{ type: 'input_statement', name: 'DO' }],
    tooltip: chinese ? '只提供手势事件，动作由下面的积木定义。保持同一手势只触发一次，再次触发需先放下手。'
      : 'Emits a gesture event; define actions below. A held gesture fires once. Release your hand before retriggering.',
  }, ...(['start', 'stop'] as const).map(action => ({
    type: `cf_camera_gesture_${action}`, colour, previousStatement: null, nextStatement: null,
    message0: chinese ? `${action === 'start' ? '开启' : '停止'}手势识别`
      : `${action === 'start' ? 'Start' : 'Stop'} gesture recognition`,
  }))]);
  for (const action of ['start', 'stop']) {
    generator.forBlock[`cf_camera_gesture_${action}`] = () => `cf_camera_gesture_${action}()\n`;
  }
  generator.forBlock['cf_camera_gesture_on'] = (block, runtime) => `cf_camera_gesture_on(${JSON.stringify({
    gesture: block.getFieldValue('GESTURE'), holdSeconds: Number(block.getFieldValue('HOLD')),
    code: runtime.statementToCode(block, 'DO'), blockIds: [],
  })})\n`;
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
      { kind: 'block', type: 'cf_camera_gesture_on' },
      { kind: 'block', type: 'cf_camera_gesture_start' },
      { kind: 'block', type: 'cf_camera_gesture_stop' },
    ],
  };
}

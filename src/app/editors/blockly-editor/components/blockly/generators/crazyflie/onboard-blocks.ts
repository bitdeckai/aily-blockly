import * as Blockly from 'blockly';

export const onboardGroups = ['attitude', 'battery', 'position', 'all'] as const;
export type OnboardGroup = typeof onboardGroups[number];

export function parseOnboardCall(line: string): OnboardGroup | undefined {
  if (!/^cf_log_onboard\s*\(/.test(line)) return undefined;
  const match = /^cf_log_onboard\s*\(\s*(['"])(attitude|battery|position|all)\1\s*\)\s*;?$/.exec(line);
  if (!match) throw new Error('Crazyflie: invalid onboard data command');
  return onboardGroups.find(group => group === match[2]);
}

export function validateOnboardSequence(code: string): void {
  let connected = false;
  for (const raw of code.split(/\r?\n/)) {
    const line = raw.trim();
    if (/^cf_crazyflie_link\s*\(\s*\)/.test(line)) connected = true;
    if (parseOnboardCall(line) && !connected) {
      throw new Error('Crazyflie: run Crazyflie link before reading onboard data');
    }
  }
}

export function registerCrazyflieOnboardBlocks(generator: Blockly.CodeGenerator, chinese: boolean): void {
  Blockly.defineBlocksWithJsonArray([{
    type: 'cf_log_onboard',
    message0: chinese ? '读取并打印本体 %1' : 'read and print onboard %1',
    args0: [{
      type: 'field_dropdown', name: 'GROUP',
      options: [
        [chinese ? '姿态 Roll/Pitch/Yaw（度）' : 'attitude Roll/Pitch/Yaw (degrees)', 'attitude'],
        [chinese ? '电池电压（伏）' : 'battery voltage (V)', 'battery'],
        [chinese ? '估计位置 X/Y/Z（米）' : 'estimated position X/Y/Z (m)', 'position'],
        [chinese ? '全部数据' : 'all data', 'all'],
      ],
    }],
    previousStatement: null, nextStatement: null, colour: '#458b78',
    tooltip: chinese
      ? '执行时采集新数据并打印；先连接 Crazyflie。不参与条件判断。位置可靠性取决于定位配置。'
      : 'Sample fresh data and print at execution time; connect first. Not a condition input. Position reliability depends on localization.',
  }]);
  generator.forBlock['cf_log_onboard'] = block => {
    const group = block.getFieldValue('GROUP');
    if (!onboardGroups.some(item => item === group)) throw new Error('Crazyflie: invalid onboard data group');
    return `cf_log_onboard("${group}")\n`;
  };
}

export function createCrazyflieOnboardToolbox(chinese: boolean) {
  return {
    kind: 'category', name: chinese ? '本体数据' : 'Onboard data',
    categoryId: 'crazyflie-onboard', icon: 'fa-light fa-gauge', colour: '#458b78',
    contents: onboardGroups.map(group => ({
      kind: 'block', type: 'cf_log_onboard', fields: { GROUP: group },
    })),
  };
}

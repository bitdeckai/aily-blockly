import * as Blockly from 'blockly';

export const CRAZYRADIO_COLOUR = '#4a87c6';
export const crazyradioBlockTypes = ['cf_test_link', 'cf_scan_links', 'cf_radio_config', 'cf_link_config'];

export function registerCrazyradioBlocks(generator: Blockly.CodeGenerator, chinese: boolean): void {
  Blockly.defineBlocksWithJsonArray([
    {
      type: 'cf_test_link', message0: chinese ? '检测无线收发器' : 'Check radio',
      previousStatement: null, nextStatement: null, colour: CRAZYRADIO_COLOUR,
      tooltip: chinese ? '检查 Crazyradio USB 无线收发器，输出版本信息，不连接飞行器。'
        : 'Check the Crazyradio USB dongle and print its version without connecting to an aircraft.',
    },
    {
      type: 'cf_scan_links', message0: chinese ? '扫描飞行器' : 'Scan aircraft',
      previousStatement: null, nextStatement: null, colour: CRAZYRADIO_COLOUR,
      tooltip: chinese ? '使用无线收发器 0，按当前地址扫描并输出 URI；放在流程开头、连接之前，不启动电机。'
        : 'Scan with radio 0 at the configured address and print URIs. Place at the start, before connecting. No motors.',
    },
    {
      type: 'cf_radio_config',
      message0: chinese ? '无线收发器 %1 信道 %2 速率 %3 地址 %4' : 'Radio %1 channel %2 rate %3 address %4',
      args0: [
        { type: 'field_number', name: 'RADIO', value: 0, min: 0, max: 15, precision: 1 },
        { type: 'field_number', name: 'CHANNEL', value: 80, min: 0, max: 125, precision: 1 },
        { type: 'field_dropdown', name: 'RATE', options: [['2M', '2M'], ['1M', '1M'], ['250K', '250K']] },
        { type: 'field_input', name: 'ADDRESS', text: 'E7E7E7E7E7' },
      ],
      previousStatement: null, nextStatement: null, colour: CRAZYRADIO_COLOUR,
      tooltip: chinese ? '设置本次连接参数，不修改飞行器固件中的信道或地址；连接前设置。'
        : 'Configure this connection before connecting; does not change the aircraft firmware channel or address.',
    },
    {
      type: 'cf_link_config', message0: chinese ? '连接 URI %1 地址 %2' : 'Link URI %1 address %2',
      args0: [
        { type: 'field_input', name: 'URI', text: 'radio://0/80/2M' },
        { type: 'field_input', name: 'ADDRESS', text: 'E7E7E7E7E7' },
      ],
      previousStatement: null, nextStatement: null, colour: CRAZYRADIO_COLOUR,
      tooltip: chinese ? '旧版连接设置积木；新流程使用无线收发器参数积木，放在连接前。'
        : 'Configure the full link URI before connecting; use this or the radio parameter block.',
    },
  ]);
  generator.forBlock['cf_test_link'] = () => 'cf_test_link()\n';
  generator.forBlock['cf_scan_links'] = () => 'cf_scan_links()\n';
  for (const type of ['cf_radio_config', 'cf_link_config']) {
    generator.forBlock[type] = block => {
      const address = String(block.getFieldValue('ADDRESS')).trim().replace(/^0x/i, '').toUpperCase();
      if (!/^[0-9A-F]{10}$/.test(address)) throw new Error('Crazyradio: address must contain 10 hexadecimal digits');
      let uri = String(block.getFieldValue('URI') || '').trim();
      if (type === 'cf_radio_config') {
        const radio = Number(block.getFieldValue('RADIO'));
        const channel = Number(block.getFieldValue('CHANNEL'));
        const rate = String(block.getFieldValue('RATE'));
        if (!Number.isInteger(radio) || radio < 0 || radio > 15
          || !Number.isInteger(channel) || channel < 0 || channel > 125
          || !['250K', '1M', '2M'].includes(rate)) {
          throw new Error('Crazyradio: invalid radio index, channel or data rate');
        }
        uri = `radio://${radio}/${channel}/${rate}`;
      }
      const match = /^radio:\/\/([A-Za-z0-9]+)\/(\d+)\/(250K|1M|2M)(?:\/[0-9a-fA-F]{10})?(\?[^ \r\n]*)?$/.exec(uri);
      if (!match || Number(match[2]) > 125) throw new Error('Crazyradio: invalid radio URI');
      uri = `radio://${match[1]}/${Number(match[2])}/${match[3]}/${address}${match[4] || ''}`;
      return `cf_set_link(${JSON.stringify(uri)}, ${JSON.stringify(address)})\n`;
    };
  }
}

export function createCrazyradioToolbox() {
  return {
    kind: 'category', name: 'Crazyradio', categoryId: 'crazyradio',
    icon: 'fa-light fa-tower-broadcast', colour: CRAZYRADIO_COLOUR,
    contents: crazyradioBlockTypes.filter(type => type !== 'cf_link_config').map(type => ({
      kind: 'block', type,
      ...(type === 'cf_radio_config' ? { fields: { RATE: '2M' } } : {}),
    })),
  };
}

export function validateRadioScanSequence(commands: Array<{ type: string }>): void {
  let radioPrefix = true;
  for (const command of commands) {
    if (command.type === 'scan_links' && !radioPrefix) {
      throw new Error('Crazyradio: place scanning at the start of the flow, before connecting');
    }
    if (!['set_link', 'test_link', 'scan_links'].includes(command.type)) radioPrefix = false;
  }
}

export function validateRadioScanCode(code: string): void {
  validateRadioScanSequence(code.split(/\r?\n/).map(line => line.trim())
    .filter(line => line && !line.startsWith('#')).map(line => ({
      type: /^cf_set_link\s*\(/.test(line) ? 'set_link'
        : /^cf_test_link\s*\(/.test(line) ? 'test_link'
        : /^cf_scan_links\s*\(/.test(line) ? 'scan_links' : 'other',
    })));
}

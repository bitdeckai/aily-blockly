export type AiDeckCameraCommand = { type: 'configure'; address: string } | { type: 'open' | 'close' };

export function aiDeckStreamUrl(address: string): string {
  const value = address.trim();
  if (!value || /\s/.test(value)) throw new Error('AI_DECK_CAMERA.INVALID_ADDRESS');
  const url = new URL(/^[a-z][a-z\d+.-]*:\/\//i.test(value) ? value : `http://${value}`);
  if (!['http:', 'https:'].includes(url.protocol) || !url.hostname || url.username || url.password || url.hash) {
    throw new Error('AI_DECK_CAMERA.INVALID_ADDRESS');
  }
  if (url.pathname === '/') url.pathname = '/stream';
  return url.href;
}

export function parseAiDeckCameraCall(line: string): AiDeckCameraCommand | undefined {
  if (!/^cf_ai_deck_/.test(line)) return undefined;
  const config = /^cf_ai_deck_config\s*\(\s*("(?:[^"\\]|\\.)*")\s*\)\s*;?$/.exec(line);
  if (config) {
    const address: unknown = JSON.parse(config[1]);
    if (typeof address !== 'string') throw new Error('AI Deck: invalid address');
    aiDeckStreamUrl(address);
    return { type: 'configure', address: address.trim() };
  }
  const action = /^cf_ai_deck_(open|close)\s*\(\s*\)\s*;?$/.exec(line)?.[1];
  if (action === 'open' || action === 'close') return { type: action };
  throw new Error('AI Deck: invalid camera command');
}

export function validateAiDeckCameraSequence(code: string): void {
  let configured = false;
  for (const raw of code.split(/\r?\n/)) {
    const command = parseAiDeckCameraCall(raw.trim());
    if (command?.type === 'configure') configured = true;
    if (command?.type === 'open' && !configured) throw new Error('AI Deck: configure the device address before opening video');
  }
}

export function isAiDeckCameraOnlyFlow(code: string): boolean {
  const lines = code.split(/\r?\n/).map(line => line.trim()).filter(line => line && !line.startsWith('#'));
  return lines.some(line => !!parseAiDeckCameraCall(line))
    && lines.every(line => !!parseAiDeckCameraCall(line) || /^cf_(?:delay|print)\s*\(.*\)\s*;?$/.test(line));
}

export function parseAiDeckCameraEvent(line: string): AiDeckCameraCommand | undefined {
  if (!line.startsWith('__AIDECK__:')) return undefined;
  const command: unknown = JSON.parse(line.slice('__AIDECK__:'.length));
  if (typeof command === 'object' && command !== null && 'type' in command) {
    if (command.type === 'configure' && 'address' in command && typeof command.address === 'string') {
      aiDeckStreamUrl(command.address);
      return { type: 'configure', address: command.address };
    }
    if (command.type === 'open' || command.type === 'close') return { type: command.type };
  }
  throw new Error('AI Deck: invalid camera runtime event');
}

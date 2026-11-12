import { CodexAdapter } from './codex.mjs';
import { AntigravityAdapter } from './antigravity.mjs';
import { ChannelAdapter } from './channel.mjs';
import { PiAdapter } from './pi.mjs';

export function createAdapters(config) {
  return [
    new CodexAdapter(config),
    new AntigravityAdapter(config),
    new ChannelAdapter(config, 'claude'),
    new ChannelAdapter(config, 'deepseek'),
    new PiAdapter(config),
  ];
}

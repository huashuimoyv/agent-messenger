import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { configuration } from '../src/config.mjs';
import { atomicJson } from '../src/io.mjs';
import { APP_VERSION } from '../src/version.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const config = configuration();
const plugin = path.join(root, 'plugins', 'claude', 'generated');
const source = fs.readFileSync(path.join(root, 'plugins', 'claude', 'register.template.ts'), 'utf8');
for (const client of ['claude', 'deepseek']) for (const folder of ['sessions', 'prompts', 'calls']) fs.mkdirSync(path.join(config[`${client}Channel`], folder), { recursive: true, mode: 0o700 });
atomicJson(path.join(plugin, '.claude-plugin', 'marketplace.json'), { name: 'agent-messenger', owner: { name: 'Agent Messenger' }, plugins: [{ name: 'agent-messenger', source: './' }] });
atomicJson(path.join(plugin, '.claude-plugin', 'plugin.json'), { name: 'agent-messenger', version: APP_VERSION, description: 'Queue messages into this existing session, without any HUD or approval hook.' });
atomicJson(path.join(plugin, 'hooks', 'hooks.json'), { modules: ['./register.ts'] });
fs.writeFileSync(path.join(plugin, 'hooks', 'register.ts'), source.replace('__AGENT_MESSENGER_CHANNEL_JSON__', JSON.stringify(config.claudeChannel)));
console.log(JSON.stringify({ claude_plugin: plugin, claude_channel: config.claudeChannel, deepseek_plugin: path.join(root, 'plugins', 'deepseek', 'agent-messenger.mjs'), deepseek_channel: config.deepseekChannel }));

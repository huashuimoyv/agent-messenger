import os from 'node:os';
import path from 'node:path';

export function configuration(env = process.env) {
  const home = os.homedir();
  const data = env.AGENT_MESSENGER_HOME || path.join(env.LOCALAPPDATA || path.join(home, '.local', 'share'), 'agent-messenger');
  return {
    home,
    data,
    codexHome: env.CODEX_HOME || path.join(home, '.codex'),
    codexExecutable: env.AGENT_MESSENGER_CODEX || null,
    claudeHome: env.CLAUDE_CONFIG_DIR || path.join(home, '.claude'),
    deepseekHome: env.DSH_HOME || path.join(home, '.dsh'),
    piHome: env.PI_CODING_AGENT_DIR || path.join(home, '.pi', 'agent'),
    piCli: env.AGENT_MESSENGER_PI || undefined,
    piAutoSpawn: true,
    claudeChannel: path.join(data, 'claude-channel'),
    deepseekChannel: path.join(data, 'deepseek-channel'),
    piChannel: path.join(data, 'pi-channel'),
    passLimit: 10,
  };
}

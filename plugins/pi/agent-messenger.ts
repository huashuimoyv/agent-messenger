// Agent Messenger Pi Extension
// Injects incoming messages from other agents and reports session status.
import { mkdirSync, writeFileSync, renameSync, readdirSync, readFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

export default function (pi) {
  const dataDir = process.env.AGENT_MESSENGER_HOME || join(process.env.LOCALAPPDATA || join(homedir(), '.local', 'share'), 'agent-messenger');
  const channel = process.env.AGENT_MESSENGER_PI_CHANNEL || join(dataDir, 'pi-channel');
  const pid = process.pid;

  let heartbeatTimer;
  let pollTimer;
  let currentSessionId;
  let currentSessionFile;

  const file = (...parts) => join(channel, ...parts);
  const writeJson = (target, value) => {
    mkdirSync(join(target, '..'), { recursive: true });
    const temp = `${target}.${randomUUID()}.tmp`;
    try {
      writeFileSync(temp, JSON.stringify(value), 'utf8');
      renameSync(temp, target);
    } catch {}
  };

  function checkIn(state = 'idle') {
    if (!currentSessionId) return;
    writeJson(file('sessions', `${currentSessionId}.json`), {
      at: Date.now(),
      pid,
      sessionFile: currentSessionFile,
      channelVersion: 1,
      state
    });
  }

  function pollPrompts(ctx) {
    if (!currentSessionId) return;
    const promptsFolder = file('prompts', currentSessionId);
    if (!existsSync(promptsFolder)) return;

    try {
      const files = readdirSync(promptsFolder).filter(n => n.endsWith('.json'));
      for (const name of files) {
        const targetPath = join(promptsFolder, name);
        try {
          const content = JSON.parse(readFileSync(targetPath, 'utf8'));
          if (content.takenAt || content.refused || content.expiredAt) continue;

          if (content.expiresAt && content.expiresAt <= Date.now()) {
            writeJson(targetPath, { ...content, expiredAt: Date.now() });
            continue;
          }

          // If agent is currently busy, deliver as follow-up to prevent drop
          const options = (typeof ctx?.isIdle === 'function' && !ctx.isIdle()) ? { deliverAs: 'followUp' } : undefined;

          // Attempt to send message
          if (typeof pi.sendUserMessage === 'function') {
            pi.sendUserMessage(content.text, options);
          } else if (typeof ctx?.ui?.sendUserMessage === 'function') {
            ctx.ui.sendUserMessage(content.text, options);
          } else {
            continue;
          }

          // Mark takenAt and startedAt only after successful submission
          writeJson(targetPath, { ...content, takenAt: Date.now(), startedAt: Date.now() });
        } catch (err) {
          // Record error without marking takenAt to allow subsequent retry
          try {
            const raw = JSON.parse(readFileSync(targetPath, 'utf8'));
            writeJson(targetPath, { ...raw, lastError: String(err?.message || err), errorAt: Date.now() });
          } catch {}
        }
      }
    } catch {}
  }

  pi.on('session_start', (_event, ctx) => {
    currentSessionId = ctx.sessionManager?.getSessionId?.();
    currentSessionFile = ctx.sessionManager?.getSessionFile?.();
    if (!currentSessionId) return;

    checkIn('idle');

    if (!heartbeatTimer) {
      heartbeatTimer = setInterval(() => checkIn(ctx.isIdle?.() === false ? 'running' : 'idle'), 5000);
      heartbeatTimer.unref();
    }

    if (!pollTimer) {
      pollTimer = setInterval(() => pollPrompts(ctx), 1000);
      pollTimer.unref();
    }
  });

  pi.on('agent_start', () => {
    checkIn('running');
  });

  pi.on('agent_settled', () => {
    checkIn('idle');
  });

  pi.on('session_shutdown', () => {
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    if (pollTimer) clearInterval(pollTimer);
    if (currentSessionId) {
      writeJson(file('sessions', `${currentSessionId}.json`), { ended: Date.now() });
    }
  });
}

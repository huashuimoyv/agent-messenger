// Agent Messenger Pi Extension
// Injects incoming messages from other agents, reports session status, and tracks caller identity for MCP calls.
import { mkdirSync, writeFileSync, renameSync, readdirSync, readFileSync, rmSync, statSync, existsSync } from 'node:fs';
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
  const queues = new Map();
  const notes = new Set();

  const file = (...parts) => join(channel, ...parts);
  const writeJson = (target, value) => {
    mkdirSync(join(target, '..'), { recursive: true });
    const temp = `${target}.${randomUUID()}.tmp`;
    try {
      writeFileSync(temp, JSON.stringify(value), 'utf8');
      renameSync(temp, target);
    } catch {}
  };

  function checkIn() {
    if (!currentSessionId) return;
    writeJson(file('sessions', `${currentSessionId}.json`), {
      at: Date.now(),
      pid,
      sessionFile: currentSessionFile,
      channelVersion: 1,
      state: 'idle'
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

          // Mark as taken
          writeJson(targetPath, { ...content, takenAt: Date.now(), startedAt: Date.now() });

          // Send message to Pi session
          if (typeof pi.sendUserMessage === 'function') {
            pi.sendUserMessage(content.text);
          } else if (typeof ctx?.ui?.sendUserMessage === 'function') {
            ctx.ui.sendUserMessage(content.text);
          }
        } catch {}
      }
    } catch {}
  }

  pi.on('session_start', (_event, ctx) => {
    currentSessionId = ctx.sessionManager?.getSessionId?.();
    currentSessionFile = ctx.sessionManager?.getSessionFile?.();
    if (!currentSessionId) return;

    checkIn();

    if (!heartbeatTimer) {
      heartbeatTimer = setInterval(checkIn, 5000);
      heartbeatTimer.unref();
    }

    if (!pollTimer) {
      pollTimer = setInterval(() => pollPrompts(ctx), 1000);
      pollTimer.unref();
    }
  });

  pi.on('agent_start', () => {
    if (currentSessionId) {
      writeJson(file('sessions', `${currentSessionId}.json`), {
        at: Date.now(),
        pid,
        sessionFile: currentSessionFile,
        state: 'running'
      });
    }
  });

  pi.on('agent_settled', () => {
    if (currentSessionId) {
      checkIn();
    }
  });

  pi.on('tools/execute', async (event, next) => {
    let noteFile;
    const toolName = event.name || event.toolName;
    if (toolName && toolName.includes('agent-messenger') && currentSessionId) {
      const toolShort = toolName.replace(/^.*?agent[-_]messenger__/, '');
      noteFile = file('calls', String(pid), `${randomUUID()}.json`);
      writeJson(noteFile, {
        tool: toolShort,
        arguments: event.arguments || {},
        sessionId: currentSessionId,
        at: Date.now()
      });
      notes.add(noteFile);
    }

    try {
      return await next();
    } finally {
      if (noteFile) {
        try { rmSync(noteFile, { force: true }); } catch {}
        notes.delete(noteFile);
      }
    }
  });

  pi.on('session_shutdown', () => {
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    if (pollTimer) clearInterval(pollTimer);
    if (currentSessionId) {
      writeJson(file('sessions', `${currentSessionId}.json`), { ended: Date.now() });
    }
    for (const note of notes) {
      try { rmSync(note, { force: true }); } catch {}
    }
  });
}

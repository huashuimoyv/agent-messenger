// Agent Messenger Pi Extension — thin event-driven transport shell.
import { mkdirSync, writeFileSync, renameSync, readdirSync, readFileSync, rmSync, watch } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

const SAFE_ID = /^[A-Za-z0-9_-]{1,128}$/;

export default function (pi) {
  const dataDir = process.env.AGENT_MESSENGER_HOME || join(process.env.LOCALAPPDATA || join(homedir(), '.local', 'share'), 'agent-messenger');
  const channel = process.env.AGENT_MESSENGER_PI_CHANNEL || join(dataDir, 'pi-channel');
  const pid = process.pid;

  let heartbeatTimer = null;
  let sweepTimer = null;
  let debounceTimer = null;
  let promptWatcher = null;
  let currentSessionId = null;
  let currentSessionFile = null;
  let busy = false;
  let draining = false;

  const file = (...parts) => join(channel, ...parts);
  const writeJson = (target, value) => {
    mkdirSync(join(target, '..'), { recursive: true });
    const temp = `${target}.${randomUUID()}.tmp`;
    try {
      writeFileSync(temp, JSON.stringify(value), 'utf8');
      renameSync(temp, target);
    } finally {
      try { rmSync(temp, { force: true }); } catch {}
    }
  };

  const isSessionBusy = ctx => busy || (typeof ctx?.isIdle === 'function' && !ctx.isIdle());

  function checkIn(ctx) {
    if (!currentSessionId) return;
    writeJson(file('sessions', `${currentSessionId}.json`), {
      at: Date.now(),
      pid,
      sessionFile: currentSessionFile,
      channelVersion: 2,
      state: isSessionBusy(ctx) ? 'running' : 'idle',
    });
  }

  function drainPrompts(ctx) {
    if (!currentSessionId || draining) return;
    draining = true;
    try {
      const folder = file('prompts', currentSessionId);
      const pending = [];
      for (const name of readdirSync(folder)) {
        if (!name.endsWith('.json')) continue;
        const targetPath = join(folder, name);
        try {
          const prompt = JSON.parse(readFileSync(targetPath, 'utf8'));
          if (typeof prompt?.text !== 'string' || !SAFE_ID.test(prompt.id)) continue;
          if (prompt.takenAt || prompt.refused || prompt.expiredAt) continue;
          pending.push({ targetPath, prompt });
        } catch {}
      }
      pending.sort((a, b) => (a.prompt.at || 0) - (b.prompt.at || 0) || String(a.prompt.id).localeCompare(String(b.prompt.id)));

      for (const { targetPath, prompt } of pending) {
        const now = Date.now();
        if (prompt.expiresAt && prompt.expiresAt <= now) {
          try { writeJson(targetPath, { ...prompt, expiredAt: now }); } catch {}
          continue;
        }
        const options = isSessionBusy(ctx) ? { deliverAs: 'followUp' } : undefined;
        try {
          if (typeof pi.sendUserMessage === 'function') {
            pi.sendUserMessage(prompt.text, options);
          } else if (typeof ctx?.ui?.sendUserMessage === 'function') {
            ctx.ui.sendUserMessage(prompt.text, options);
          } else {
            continue;
          }
          busy = true;
          writeJson(targetPath, { ...prompt, takenAt: now, startedAt: now });
        } catch (err) {
          // Fallback: if Pi transitioned into streaming mid-call without deliverAs, retry once as followUp.
          if (!options && typeof pi.sendUserMessage === 'function') {
            try {
              pi.sendUserMessage(prompt.text, { deliverAs: 'followUp' });
              busy = true;
              writeJson(targetPath, { ...prompt, takenAt: now, startedAt: now });
              continue;
            } catch {}
          }
          try { writeJson(targetPath, { ...prompt, lastError: String(err?.message || err), errorAt: now }); } catch {}
        }
      }
    } catch {} finally {
      draining = false;
    }
  }

  function scheduleDrain(ctx) {
    if (debounceTimer) return;
    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      drainPrompts(ctx);
    }, 20);
    debounceTimer.unref?.();
  }

  function cleanup() {
    if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null; }
    if (sweepTimer) { clearInterval(sweepTimer); sweepTimer = null; }
    if (debounceTimer) { clearTimeout(debounceTimer); debounceTimer = null; }
    if (promptWatcher) { try { promptWatcher.close(); } catch {} promptWatcher = null; }
  }

  pi.on('session_start', (_event, ctx) => {
    cleanup();
    currentSessionId = ctx.sessionManager?.getSessionId?.() || null;
    currentSessionFile = ctx.sessionManager?.getSessionFile?.() || null;
    busy = false;
    if (!currentSessionId) return;

    const promptsFolder = file('prompts', currentSessionId);
    mkdirSync(promptsFolder, { recursive: true });
    checkIn(ctx);
    drainPrompts(ctx);

    try {
      promptWatcher = watch(promptsFolder, { persistent: false }, () => scheduleDrain(ctx));
      promptWatcher.on('error', () => {});
    } catch {}

    heartbeatTimer = setInterval(() => checkIn(ctx), 5000);
    heartbeatTimer.unref?.();

    sweepTimer = setInterval(() => drainPrompts(ctx), 10000);
    sweepTimer.unref?.();
  });

  pi.on('agent_start', (_event, ctx) => {
    busy = true;
    checkIn(ctx);
  });

  pi.on('agent_settled', (_event, ctx) => {
    busy = false;
    checkIn(ctx);
  });

  pi.on('session_shutdown', () => {
    cleanup();
    if (currentSessionId) {
      try { writeJson(file('sessions', `${currentSessionId}.json`), { ended: Date.now() }); } catch {}
      currentSessionId = null;
    }
  });
}

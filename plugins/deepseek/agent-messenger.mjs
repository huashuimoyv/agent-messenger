// Message delivery and caller notes adapted from Agent HUD, Apache-2.0.
// This plugin has no approval, question, UI or quota hooks.
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export const name = 'agent-messenger';
export const inject = ['agents'];
const safe = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
const prefix = 'mcp__agent-messenger__';

export function apply(ctx, config) {
  if (!path.isAbsolute(config.channel)) throw new Error('agent-messenger: channel must be an absolute directory');
  const plugin = start(ctx, config.channel);
  ctx.effect(() => () => plugin.stop());
}

export function start(ctx, channel, options = {}) {
  const now = options.now || Date.now, host = options.host || process.pid;
  const timers = [], watchers = new Map(), checked = new Set(), notes = new Set(), queues = new Map();
  const file = (...parts) => path.join(channel, ...parts);
  const write = (target, value) => {
    fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
    const temp = `${target}.${randomUUID()}.tmp`;
    try { fs.writeFileSync(temp, JSON.stringify(value), { mode: 0o600 }); fs.renameSync(temp, target); }
    finally { fs.rmSync(temp, { force: true }); }
  };
  const report = error => process.stderr.write(`agent-messenger plugin: ${error.message}\n`);
  const safeRun = work => { try { Promise.resolve(work()).catch(report); } catch (error) { report(error); } };
  const roots = () => ctx.agents.list().filter(a => safe(a.id) && !a.parent);
  const ensureWatcher = id => {
    if (watchers.has(id)) return;
    const folder = file('prompts', id);
    try {
      fs.mkdirSync(folder, { recursive: true, mode: 0o700 });
      const watcher = fs.watch(folder, { persistent: false }, () => safeRun(prompts));
      watcher.on('error', () => {});
      watchers.set(id, watcher);
    } catch {}
  };
  const checkIns = () => {
    const open = new Set();
    for (const a of roots()) { open.add(a.id); checked.add(a.id); ensureWatcher(a.id); write(file('sessions', `${a.id}.json`), { at: now(), host, channelVersion: 1 }); }
    for (const id of checked) if (!open.has(id)) {
      write(file('sessions', `${id}.json`), { ended: now() });
      checked.delete(id);
      const w = watchers.get(id); if (w) { try { w.close(); } catch {} watchers.delete(id); }
    }
  };
  const prompts = () => {
    for (const a of roots()) {
      const folder = file('prompts', a.id);
      if (!fs.existsSync(folder)) continue;
      const pending = fs.readdirSync(folder).filter(n => n.endsWith('.json')).map(n => ({ target: path.join(folder, n), prompt: JSON.parse(fs.readFileSync(path.join(folder, n), 'utf8')) }))
        .filter(({ prompt: p }) => typeof p.text === 'string' && safe(p.id) && !p.takenAt && !p.expiredAt && !p.refused)
        .sort((a, b) => a.prompt.at - b.prompt.at || a.prompt.id.localeCompare(b.prompt.id));
      for (const { target, prompt } of pending) {
        if (prompt.expiresAt <= now()) { write(target, { expiredAt: now() }); continue; }
        const controller = ctx.get('sessionController');
        if (typeof controller?.prompt !== 'function') continue;
        const takenAt = now();
        write(target, { takenAt });
        const before = queues.get(a.id) || Promise.resolve();
        const submitted = before.then(() => controller.prompt({ requestId: prompt.id, sessionId: a.id, mode: 'queue', content: [{ type: 'text', text: prompt.text }] }, new AbortController().signal))
          .then(result => write(target, result?.accepted === false ? { takenAt, refused: String(result.reason || 'refused') } : { takenAt, startedAt: now() }), error => write(target, { takenAt, refused: String(error.message || error) }));
        queues.set(a.id, submitted);
        submitted.finally(() => { if (queues.get(a.id) === submitted) queues.delete(a.id); }).catch(report);
      }
    }
  };
  ctx.on('tools/execute', async (exec, next) => {
    let note;
    if (exec.name.startsWith(prefix) && safe(exec.agent?.id)) {
      note = file('calls', String(host), `${randomUUID()}.json`);
      write(note, { tool: exec.name.slice(prefix.length), arguments: exec.arguments || {}, sessionId: exec.agent.id, at: now() });
      notes.add(note);
    }
    try { return await next(); }
    finally { if (note) { fs.rmSync(note, { force: true }); notes.delete(note); } }
  });
  const tick = () => { checkIns(); prompts(); };
  safeRun(checkIns);
  for (const [ms, work] of [[5000, checkIns], [5000, prompts]]) {
    const timer = setInterval(() => safeRun(work), ms); timer.unref(); timers.push(timer);
  }
  return { tick, stop() {
    timers.forEach(clearInterval);
    for (const w of watchers.values()) { try { w.close(); } catch {} }
    watchers.clear();
    for (const id of checked) write(file('sessions', `${id}.json`), { ended: now() });
    for (const note of notes) fs.rmSync(note, { force: true });
  } };
}

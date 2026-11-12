import fs from 'node:fs';
import path from 'node:path';
import { entries, readJson, atomicJson, validName, DeliveryError } from './io.mjs';

export const HEARTBEAT_TTL_MS = 25_000;
const GC_INTERVAL_MS = 3_600_000;
const RETENTION_MS = 7 * 86_400_000;
const lastGcAt = new Map();

export class FileChannel {
  constructor(root, { ttlMs = HEARTBEAT_TTL_MS } = {}) {
    this.root = root;
    this.ttlMs = ttlMs;
    this.scheduleGc();
  }

  scheduleGc() {
    if (!this.root) return;
    const now = Date.now();
    if (now - (lastGcAt.get(this.root) || 0) < GC_INTERVAL_MS) return;
    lastGcAt.set(this.root, now);
    const promptsRoot = path.join(this.root, 'prompts');
    setImmediate(() => {
      try {
        const cutoff = Date.now() - RETENTION_MS;
        for (const folder of entries(promptsRoot).filter(e => e.isDirectory())) {
          const dir = path.join(promptsRoot, folder.name);
          for (const entry of entries(dir).filter(e => e.isFile() && (e.name.endsWith('.json') || e.name.endsWith('.expired')))) {
            const target = path.join(dir, entry.name);
            try {
              if (fs.statSync(target).mtimeMs < cutoff) fs.rmSync(target, { force: true });
            } catch {}
          }
        }
      } catch {}
    }).unref?.();
  }

  status(rawId) {
    if (!this.root || !rawId) return { live: null, present: false, ended: false };
    const file = path.join(this.root, 'sessions', `${rawId}.json`);
    let stat;
    try { stat = fs.statSync(file); }
    catch { return { live: null, present: false, ended: false }; }
    const value = readJson(file);
    if (!value) return { live: null, present: false, ended: false };
    if (value.ended) return { live: null, present: true, ended: true };
    if (Date.now() - stat.mtimeMs >= this.ttlMs) return { live: null, present: true, ended: false };
    return { live: value, present: true, ended: false };
  }

  heartbeat(rawId) {
    return this.status(rawId).live;
  }

  activeIds() {
    if (!this.root) return [];
    const dir = path.join(this.root, 'sessions');
    return entries(dir)
      .filter(e => e.isFile() && e.name.endsWith('.json'))
      .map(e => e.name.slice(0, -5))
      .filter(id => validName(id) && this.heartbeat(id));
  }

  callerByPid(ppid, { fallbackSingleActive = false } = {}) {
    if (!this.root) return null;
    const dir = path.join(this.root, 'sessions');
    const active = [];
    for (const entry of entries(dir).filter(e => e.isFile() && e.name.endsWith('.json'))) {
      const id = entry.name.slice(0, -5);
      const { live } = this.status(id);
      if (!live) continue;
      if (live.pid && live.pid === ppid) return id;
      active.push(id);
    }
    return fallbackSingleActive && active.length === 1 ? active[0] : null;
  }

  callerByNote(ppid, tool, args, hashFn) {
    if (!this.root) return null;
    const dir = path.join(this.root, 'calls', String(ppid));
    const targetHash = hashFn(args);
    const notes = entries(dir)
      .filter(e => e.isFile() && e.name.endsWith('.json'))
      .map(e => readJson(path.join(dir, e.name)))
      .filter(v => v && Date.now() - v.at < 60_000 && v.tool === tool && hashFn(v.arguments) === targetHash);
    const ids = [...new Set(notes.map(v => v.sessionId).filter(Boolean))];
    return ids.length === 1 ? ids[0] : null;
  }

  enqueue(rawId, messageId, text, extra = {}) {
    const file = path.join(this.root, 'prompts', rawId, `${messageId}.json`);
    if (fs.existsSync(file)) {
      throw new DeliveryError('This prompt id already exists in the plugin channel.', 'uncertain');
    }
    const now = Date.now();
    atomicJson(file, {
      id: messageId,
      text,
      at: now,
      expiresAt: now + 3_600_000,
      ...extra,
    });
    this.scheduleGc();
    return { state: 'queued' };
  }

  receipt(rawId, messageId, fallbackState = 'queued') {
    const file = path.join(this.root, 'prompts', rawId, `${messageId}.json`);
    const expiredMarker = file.replace(/\.json$/, '.expired');
    const cancelMarker = file.replace(/\.json$/, '.cancel');
    const hasMarker = fs.existsSync(expiredMarker) || fs.existsSync(cancelMarker) || fs.existsSync(file + '.expired');
    let raw = readJson(file);
    const sessionFile = path.join(this.root, 'sessions', `${rawId}.json`);
    const sessionRaw = readJson(sessionFile);

    // Prioritize concrete progress states (refused, started, taken).
    // An already claimed or started prompt must never be falsely marked expired or overwritten.
    let state = raw?.refused ? 'refused'
      : raw?.startedAt ? 'started'
      : raw?.takenAt ? 'taken'
      : (raw?.expiredAt || hasMarker) ? 'expired'
      : (fallbackState || 'queued');

    // Only un-taken, un-started prompts expire due to TTL or ended session
    if (raw?.text && !raw.takenAt && !raw.startedAt) {
      if (raw.expiresAt <= Date.now() || sessionRaw?.ended) {
        // Double check disk to prevent clobbering an in-flight claim by another process
        const current = readJson(file);
        if (current?.startedAt || current?.takenAt || current?.refused) {
          raw = current;
          state = current.refused ? 'refused' : current.startedAt ? 'started' : 'taken';
        } else {
          state = 'expired';
          if (!hasMarker && fs.existsSync(file)) {
            try { fs.writeFileSync(expiredMarker, JSON.stringify({ at: Date.now() })); } catch {}
            try { fs.writeFileSync(cancelMarker, JSON.stringify({ at: Date.now() })); } catch {}
          }
        }
      }
    }
    return { state, reason: state === 'refused' ? String(raw.refused) : (state === 'expired' && sessionRaw?.ended ? 'Target session ended before prompt was processed' : null), raw };
  }

  watchTargets(rawId, messageId) {
    if (!this.root || !rawId) return [];
    const list = [path.join(this.root, 'sessions', `${rawId}.json`)];
    if (messageId) {
      list.push(path.join(this.root, 'prompts', rawId, `${messageId}.json`));
      list.push(path.join(this.root, 'prompts', rawId, `${messageId}.expired`));
    }
    return list;
  }
}

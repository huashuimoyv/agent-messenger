import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { StringDecoder } from 'node:string_decoder';
import { Decompress } from 'fzstd';

export const validName = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
export const canonical = (client, id) => id.startsWith(`${client}:`) ? id : `${client}:${id}`;
export const rawId = (client, id) => id.startsWith(`${client}:`) ? id.slice(client.length + 1) : id;

export function envelopeMessageId(text) {
  const unwrapped = String(text || '').replace(/^The (?:agent-messenger|agent-hud) plugin sent a message:\r?\n/, '');
  const first = unwrapped.split(/\r?\n/, 1)[0];
  return first.startsWith('[Agent Messenger · ') ? first.match(/ · (m-[A-Za-z0-9_-]+)(?: · re m-[A-Za-z0-9_-]+)?\]$/)?.[1] || null : null;
}

// A native input can contain several queued envelopes. Never borrow its first
// user message, or a different envelope's body, for the requested message id.
export function messageBody(text, id) {
  const lines = String(text || '').replace(/<USER_REQUEST>/g, '\n')
    .replace(/<\/USER_REQUEST>/g, '\n</USER_REQUEST>\n').split(/\r?\n/);
  const start = lines.findIndex(line => envelopeMessageId(line.trim()) === id);
  if (start === -1) return null;
  const body = [];
  for (const line of lines.slice(start + 1)) {
    const trimmed = line.trim();
    if (trimmed === '</USER_REQUEST>' || envelopeMessageId(trimmed)) break;
    if ((trimmed.startsWith('Reply using ') || trimmed.startsWith('This answers '))
      && trimmed.includes(`reply_to: ${id}.`)) break;
    body.push(line);
  }
  return body.join('\n').trim();
}

export function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

export function entries(folder) {
  try { return fs.readdirSync(folder, { withFileTypes: true }); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
}

export function atomicJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temp, JSON.stringify(value), { mode: 0o600, flag: 'wx' });
    fs.renameSync(temp, file);
  } finally { fs.rmSync(temp, { force: true }); }
}

// Yield only complete JSONL records. The byte cursor never skips an unfinished
// UTF-8 sequence or half-written line, so the next read can resume safely.
export async function* jsonLines(file, start = 0) {
  const stream = fs.createReadStream(file, { start });
  const decoder = new StringDecoder('utf8');
  let pending = '', offset = start;
  for await (const chunk of stream) {
    pending += decoder.write(chunk);
    let newline;
    while ((newline = pending.indexOf('\n')) !== -1) {
      const line = pending.slice(0, newline + 1);
      pending = pending.slice(newline + 1);
      offset += Buffer.byteLength(line);
      if (!line.trim()) continue;
      yield { value: JSON.parse(line), offset };
    }
  }
}

// Unified JSONL / Zstd (.zst archive or .zstd concatenated frames) reader.
export async function* readRecords(file, start = 0) {
  if (!file.endsWith('.zst') && !file.endsWith('.zstd')) {
    yield* jsonLines(file, start);
    return;
  }
  const trackOffset = file.endsWith('.zst');
  const decoder = new StringDecoder('utf8');
  let pending = '', byteOffset = 0, ready = [];
  const stream = new Decompress(chunk => {
    pending += decoder.write(Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength));
    let newline;
    while ((newline = pending.indexOf('\n')) !== -1) {
      const line = pending.slice(0, newline);
      pending = pending.slice(newline + 1);
      if (trackOffset) byteOffset += Buffer.byteLength(line) + 1;
      if ((!trackOffset || byteOffset > start) && line.trim()) {
        ready.push({ value: JSON.parse(line), offset: trackOffset ? byteOffset : 0 });
      }
    }
  });
  for await (const chunk of fs.createReadStream(file, { highWaterMark: 16 * 1024 })) {
    stream.push(chunk);
    yield* ready;
    ready = [];
  }
}

export async function tailOffset(file, maxBytes = 256 * 1024) {
  const handle = await fsp.open(file, 'r');
  try {
    const { size } = await handle.stat();
    let position = Math.max(0, size - maxBytes);
    if (position === 0) return 0;
    while (position < size) {
      const length = Math.min(16 * 1024, size - position);
      const buffer = Buffer.allocUnsafe(length);
      await handle.read(buffer, 0, length, position);
      const newline = buffer.indexOf(0x0a);
      if (newline !== -1) return position + newline + 1;
      position += length;
    }
    return size;
  } finally {
    await handle.close();
  }
}

export async function headRecords(file, maxBytes = 32 * 1024, maxLines = 20) {
  const handle = await fsp.open(file, 'r');
  try {
    const { size } = await handle.stat();
    const length = Math.min(size, maxBytes);
    if (length === 0) return [];
    const buffer = Buffer.allocUnsafe(length);
    const { bytesRead } = await handle.read(buffer, 0, length, 0);
    const text = new StringDecoder('utf8').write(buffer.subarray(0, bytesRead));
    const out = [];
    let pos = 0, newline;
    while (out.length < maxLines && (newline = text.indexOf('\n', pos)) !== -1) {
      const line = text.slice(pos, newline).trim();
      pos = newline + 1;
      if (!line) continue;
      try { out.push(JSON.parse(line)); } catch {}
    }
    return out;
  } finally {
    await handle.close();
  }
}

export function textContent(content) {
  if (typeof content === 'string') return content;
  return Array.isArray(content) ? content.filter(p => ['text', 'input_text', 'output_text'].includes(p.type)).map(p => p.text || '').join('\n') : '';
}

function existingWatchDir(target) {
  let current = path.resolve(target);
  while (true) {
    try {
      const stat = fs.statSync(current);
      return stat.isDirectory() ? current : path.dirname(current);
    } catch {
      const parent = path.dirname(current);
      if (parent === current) return null;
      current = parent;
    }
  }
}

// Event-driven waiter backed by fs.watch with a lightweight fallback sweep.
export async function waitForChange(targets, timeoutMs, check) {
  const initial = await check();
  if (initial !== null && initial !== undefined) return initial;
  if (!timeoutMs || timeoutMs <= 0) return null;

  const deadline = Date.now() + timeoutMs;
  return new Promise(resolve => {
    const watchers = [];
    let settled = false, running = false, queued = false, debounceTimer = null, pollTimer = null, timeoutTimer = null;

    const cleanup = () => {
      if (debounceTimer) clearTimeout(debounceTimer);
      if (pollTimer) clearInterval(pollTimer);
      if (timeoutTimer) clearTimeout(timeoutTimer);
      for (const w of watchers) { try { w.close(); } catch {} }
    };

    const finish = value => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(value);
    };

    const evaluate = async () => {
      if (settled) return;
      if (running) { queued = true; return; }
      running = true;
      try {
        do {
          queued = false;
          const res = await check();
          if (res !== null && res !== undefined) { finish(res); return; }
          if (Date.now() >= deadline) { finish(null); return; }
        } while (queued && !settled);
      } catch {
        // Transient read race during atomic rename; next event/sweep retries.
      } finally {
        running = false;
      }
    };

    const schedule = () => {
      if (settled || debounceTimer) return;
      debounceTimer = setTimeout(() => { debounceTimer = null; void evaluate(); }, 25);
      debounceTimer.unref?.();
    };

    const dirs = new Set((targets || []).filter(Boolean).map(existingWatchDir).filter(Boolean));
    for (const dir of dirs) {
      try {
        const watcher = fs.watch(dir, { persistent: false }, schedule);
        watcher.on('error', () => {});
        watchers.push(watcher);
      } catch {}
    }

    pollTimer = setInterval(() => void evaluate(), 250);
    pollTimer.unref?.();
    timeoutTimer = setTimeout(() => void evaluate().then(() => finish(null)), Math.max(1, deadline - Date.now()));
    timeoutTimer.unref?.();
  });
}

export class DeliveryError extends Error {
  constructor(message, state = 'refused') { super(message); this.state = state; }
}

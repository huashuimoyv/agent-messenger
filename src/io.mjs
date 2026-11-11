import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { StringDecoder } from 'node:string_decoder';

export const validName = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
export const canonical = (client, id) => id.startsWith(`${client}:`) ? id : `${client}:${id}`;
export const rawId = (client, id) => id.startsWith(`${client}:`) ? id.slice(client.length + 1) : id;

export function envelopeMessageId(text) {
  const unwrapped = text.replace(/^The (?:agent-messenger|agent-hud) plugin sent a message:\r?\n/, '');
  const first = unwrapped.split(/\r?\n/, 1)[0];
  return first.startsWith('[Agent Messenger · ') ? first.match(/ · (m-[A-Za-z0-9_-]+)(?: · re m-[A-Za-z0-9_-]+)?\]$/)?.[1] || null : null;
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

export function textContent(content) {
  if (typeof content === 'string') return content;
  return Array.isArray(content) ? content.filter(p => ['text', 'input_text', 'output_text'].includes(p.type)).map(p => p.text || '').join('\n') : '';
}

export class DeliveryError extends Error {
  constructor(message, state = 'refused') { super(message); this.state = state; }
}

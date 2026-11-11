// File-channel protocol and transcript rules adapted from Agent HUD (Apache-2.0).
import fs from 'node:fs';
import path from 'node:path';
import { Decompress } from 'fzstd';
import { StringDecoder } from 'node:string_decoder';
import { canonical, rawId, validName, entries, readJson, atomicJson, jsonLines, textContent, DeliveryError, envelopeMessageId } from '../io.mjs';

async function* records(file, offset = 0) {
  if (!file.endsWith('.zstd')) { yield* jsonLines(file, offset); return; }
  const decoder = new StringDecoder('utf8');
  let pending = '', ready = [];
  // Node 24.9's native Zstd decoder stops after the first concatenated frame.
  // Harness appends one frame per write; use the small streaming decoder here.
  const stream = new Decompress(chunk => {
    pending += decoder.write(Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength));
    let at;
    while ((at = pending.indexOf('\n')) !== -1) {
      const line = pending.slice(0, at); pending = pending.slice(at + 1);
      if (line.trim()) ready.push({ value: JSON.parse(line), offset: 0 });
    }
  });
  for await (const chunk of fs.createReadStream(file, { highWaterMark: 16384 })) {
    stream.push(chunk);
    yield* ready; ready = [];
  }
  // A live log can end in an unfinished compression frame. Keep the decoder
  // open at this snapshot boundary and rescan on the next read.
}

function claudePrompt(v) {
  const content = v.message?.content, text = textContent(content);
  return !v.type?.startsWith('api-request') && (v.message?.role || v.type) === 'user'
    && !v.isMeta && !v.isCompactSummary && !v.isSidechain
    && !content?.some?.(p => p.type === 'tool_result')
    && !/^<command-name>|^<local-command-|^\[Request interrupted/.test(text);
}

export class ChannelAdapter {
  constructor(config, client) {
    this.config = config; this.client = client;
    this.channel = client === 'claude' ? config.claudeChannel : config.deepseekChannel;
    const cutoff = Date.now() - 7 * 86400000;
    for (const folder of entries(path.join(this.channel, 'prompts')).filter(e => e.isDirectory())) {
      for (const entry of entries(path.join(this.channel, 'prompts', folder.name)).filter(e => e.isFile() && e.name.endsWith('.json'))) {
        const file = path.join(this.channel, 'prompts', folder.name, entry.name);
        if (fs.statSync(file).mtimeMs < cutoff) fs.rmSync(file);
      }
    }
  }
  heartbeat(id) {
    const file = path.join(this.channel, 'sessions', `${id}.json`);
    const value = readJson(file);
    return value && !value.ended && Date.now() - fs.statSync(file).mtimeMs < 20000 ? value : null;
  }
  log(id) {
    if (this.client === 'claude') {
      for (const project of entries(path.join(this.config.claudeHome, 'projects')).filter(e => e.isDirectory())) {
        const file = path.join(this.config.claudeHome, 'projects', project.name, `${id}.jsonl`);
        if (fs.existsSync(file)) return file;
      }
    } else {
      for (const project of entries(path.join(this.config.deepseekHome, 'sessions')).filter(e => e.isDirectory())) {
        const folder = path.join(this.config.deepseekHome, 'sessions', project.name, id);
        const logs = entries(folder).filter(e => e.isFile() && /^session(?:\.v\d+)?\.jsonl(?:\.zstd)?$/.test(e.name));
        logs.sort((a, b) => fs.statSync(path.join(folder, b.name)).mtimeMs - fs.statSync(path.join(folder, a.name)).mtimeMs);
        if (logs[0]) return path.join(folder, logs[0].name);
      }
    }
    return null;
  }
  async get(id) {
    id = rawId(this.client, id);
    if (!validName(id)) return null;
    const live = this.heartbeat(id), file = this.log(id);
    if (!live && !file) return null;
    let title = live?.title || id, project = live?.project || null, state = 'unknown', current = null, end = 0, seq = 0;
    if (file) for await (const { value: v, offset } of records(file)) {
      end = offset; seq = Math.max(seq, v.seq || 0);
      if (v.cwd) project = v.cwd;
      if (this.client === 'claude') {
        if (v.isSidechain) continue;
        if (v.type === 'custom-title') title = v.customTitle || title;
        if (claudePrompt(v)) { current = { text: textContent(v.message?.content), turnId: v.promptId || v.uuid }; state = 'running'; }
        if (v.message?.role === 'assistant' && ['end_turn', 'stop_sequence'].includes(v.message.stop_reason)) state = 'idle';
        if (v.type === 'system' && ['turn_duration', 'stop_hook_summary'].includes(v.subtype)) state = 'idle';
      } else {
        if (v.type === 'session' && (v.origin === 'subagent' || v.delegationDepth > 0)) return null;
        if (v.type === 'session/title') title = v.data.title;
        if (v.type === 'turn/start') state = 'running';
        if (v.type === 'turn/end') state = 'idle';
        if (v.type === 'user/message' && v.data?.source?.kind === 'user') current = { text: textContent(v.data.content), turnId: String(v.data.turn ?? '') };
      }
    }
    return { id: canonical(this.client, id), rawId: id, client: this.client, title, project, state,
      reachable: Boolean(live), reason: live ? null : 'The standalone messenger plugin has not checked in within 20 seconds.',
      updatedAt: file ? fs.statSync(file).mtimeMs : live.at, file, _end: end, _seq: seq, _current: current };
  }
  async list({ limit = 50, offset = 0 } = {}) {
    const ids = new Set(entries(path.join(this.channel, 'sessions')).filter(e => e.isFile() && e.name.endsWith('.json')).map(e => e.name.slice(0, -5)).filter(id => validName(id) && this.heartbeat(id)));
    if (this.client === 'claude') for (const entry of entries(path.join(this.config.claudeHome, 'sessions'))) {
      if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
      const session = readJson(path.join(this.config.claudeHome, 'sessions', entry.name));
      if (!session?.sessionId || session.pidDomain && session.pidDomain !== process.platform) continue;
      if (session.pid) {
        try { process.kill(session.pid, 0); }
        catch (error) { if (error.code === 'ESRCH') continue; if (error.code !== 'EPERM') throw error; }
      }
      ids.add(session.sessionId);
    }
    const all = [];
    for (const id of ids) {
      const session = await this.get(id);
      if (session && (session.reachable || this.client === 'claude')) all.push(session);
    }
    return all.sort((a, b) => b.updatedAt - a.updatedAt).slice(offset, offset + limit);
  }
  async current(session) {
    return (await this.get(session.rawId))?._current || null;
  }
  async capture(session) { return { path: session.file, offset: session._end, seq: session._seq }; }
  async deliver(session, text, id) {
    if (!this.heartbeat(session.rawId)) throw new DeliveryError('The standalone messenger plugin is not running in this session.');
    const file = path.join(this.channel, 'prompts', session.rawId, `${id}.json`);
    if (fs.existsSync(file)) throw new DeliveryError('This prompt id already exists in the plugin channel.', 'uncertain');
    atomicJson(file, { id, text, at: Date.now(), expiresAt: Date.now() + 3600000, asUser: false });
    return { state: 'queued' };
  }
  async read(session, message) {
    const receipt = readJson(path.join(this.channel, 'prompts', session.rawId, `${message.id}.json`));
    let state = receipt?.refused ? 'refused' : receipt?.expiredAt ? 'expired' : receipt?.startedAt ? 'started' : receipt?.takenAt ? 'taken' : message.state;
    if (receipt?.text && receipt.expiresAt <= Date.now()) state = 'expired';
    if (state === 'refused') return { state, reason: receipt.refused };
    if (!session.file) return { state, reason: 'Transcript not available yet. An explicit send_message reply still works.' };
    let matched = false, done = false, answer = null, turn = null, activeTurn = null;
    const anchor = message.anchor;
    for await (const { value: v } of records(session.file, session.file === anchor.path ? anchor.offset || 0 : 0)) {
      if (session.file.endsWith('.zstd') && (v.seq || 0) <= (anchor.seq || 0)) continue;
      if (this.client === 'claude') {
        if (v.isSidechain || v.type?.startsWith('api-request')) continue;
        if (claudePrompt(v)) {
          if (matched) { done = true; break; }
          const text = textContent(v.message.content);
          if (envelopeMessageId(text) === message.id) { matched = true; turn = v.promptId || v.uuid || null; }
        } else if (matched && v.message?.role === 'assistant') {
          const text = textContent(v.message.content);
          if (text) answer = text;
          if (['end_turn', 'stop_sequence'].includes(v.message.stop_reason)) done = true;
        } else if (matched && v.type === 'system' && ['turn_duration', 'stop_hook_summary'].includes(v.subtype)) done = true;
      } else {
        if (v.type === 'turn/start') { if (matched) { done = true; break; } activeTurn = String(v.data.turn); }
        if (v.type === 'user/message' && v.data?.source?.kind === 'user') {
          const text = textContent(v.data.content);
          if (envelopeMessageId(text) === message.id) { matched = true; turn = activeTurn || String(v.data.turn ?? ''); }
        }
        if (matched && v.type === 'assistant/message' && String(v.data.turn) === turn) {
          const text = textContent(v.data.message?.content);
          if (text) answer = text;
        }
        if (matched && v.type === 'turn/end' && String(v.data.turn) === turn) { done = true; break; }
      }
    }
    return matched ? { state: done ? 'done' : 'started', answer: done ? answer : null, turn } : { state };
  }
}

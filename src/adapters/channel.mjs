// File-channel adapter for Claude Code and DeepSeek Harness, built on FileChannel.
import fs from 'node:fs';
import path from 'node:path';
import { canonical, rawId, validName, entries, readJson, readRecords, textContent, DeliveryError, envelopeMessageId } from '../io.mjs';
import { FileChannel } from '../channel-store.mjs';

function claudePrompt(v) {
  const content = v.message?.content, text = textContent(content);
  return !v.type?.startsWith('api-request') && (v.message?.role || v.type) === 'user'
    && !v.isMeta && !v.isCompactSummary && !v.isSidechain
    && !content?.some?.(p => p.type === 'tool_result')
    && !/^<command-name>|^<local-command-|^\[Request interrupted/.test(text);
}

export class ChannelAdapter {
  #logCache = new Map();

  constructor(config, client) {
    this.config = config;
    this.client = client;
    this.replyTool = 'mcp__agent-messenger__send_message';
    this.canStart = false;
    this.channel = client === 'claude' ? config.claudeChannel : config.deepseekChannel;
    this.store = new FileChannel(this.channel);
  }

  identifyCaller({ env, ppid, tool, args, hash }) {
    if (this.client === 'claude') {
      return env.CLAUDE_CODE_SESSION_ID ? { client: 'claude', rawId: env.CLAUDE_CODE_SESSION_ID, turnId: null } : null;
    }
    const id = this.store.callerByNote(ppid, tool, args, hash);
    return id ? { client: 'deepseek', rawId: id, turnId: null } : null;
  }

  heartbeat(id) {
    return this.store.heartbeat(id);
  }

  watchPaths(session, record) {
    return [session?.file, ...this.store.watchTargets(session?.rawId, record?.id)].filter(Boolean);
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

  async #scanLog(file, fallbackTitle, fallbackProject) {
    const stat = fs.statSync(file);
    const cached = this.#logCache.get(file);
    if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
      return { ...cached.data, mtimeMs: stat.mtimeMs };
    }
    let title = fallbackTitle, project = fallbackProject, state = 'unknown', current = null, end = 0, seq = 0, subagent = false;
    for await (const { value: v, offset } of readRecords(file)) {
      end = offset;
      seq = Math.max(seq, v.seq || 0);
      if (v.cwd) project = v.cwd;
      if (this.client === 'claude') {
        if (v.isSidechain) continue;
        if (v.type === 'custom-title') title = v.customTitle || title;
        if (claudePrompt(v)) { current = { text: textContent(v.message?.content), turnId: v.promptId || v.uuid }; state = 'running'; }
        if (v.message?.role === 'assistant' && ['end_turn', 'stop_sequence'].includes(v.message.stop_reason)) state = 'idle';
        if (v.type === 'system' && ['turn_duration', 'stop_hook_summary'].includes(v.subtype)) state = 'idle';
      } else {
        if (v.type === 'session' && (v.origin === 'subagent' || v.delegationDepth > 0)) { subagent = true; break; }
        if (v.type === 'session/title') title = v.data.title;
        if (v.type === 'turn/start') state = 'running';
        if (v.type === 'turn/end') state = 'idle';
        if (v.type === 'user/message' && v.data?.source?.kind === 'user') {
          current = { text: textContent(v.data.content), turnId: String(v.data.turn ?? '') };
        }
      }
    }
    const data = { title, project, state, current, end, seq, subagent };
    this.#logCache.set(file, { mtimeMs: stat.mtimeMs, size: stat.size, data });
    return { ...data, mtimeMs: stat.mtimeMs };
  }

  async get(id) {
    id = rawId(this.client, id);
    if (!validName(id)) return null;
    const live = this.heartbeat(id), file = this.log(id);
    if (!live && !file) return null;
    let title = live?.title || id, project = live?.project || null, state = 'unknown', current = null, end = 0, seq = 0, updatedAt = live?.at ?? 0;
    if (file) {
      const scanned = await this.#scanLog(file, title, project);
      if (scanned.subagent) return null;
      ({ title, project, state, current, end, seq, mtimeMs: updatedAt } = scanned);
    }
    return {
      id: canonical(this.client, id), rawId: id, client: this.client, title, project, state,
      reachable: Boolean(live), reason: live ? null : 'The standalone messenger plugin has not checked in within 25 seconds.',
      updatedAt, file, _end: end, _seq: seq, _current: current,
    };
  }

  async list({ limit = 50, offset = 0 } = {}) {
    const ids = new Set(this.store.activeIds());
    if (this.client === 'claude') {
      for (const entry of entries(path.join(this.config.claudeHome, 'sessions'))) {
        if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
        const session = readJson(path.join(this.config.claudeHome, 'sessions', entry.name));
        if (!session?.sessionId || (session.pidDomain && session.pidDomain !== process.platform)) continue;
        if (session.pid) {
          try { process.kill(session.pid, 0); }
          catch (error) { if (error.code === 'ESRCH') continue; if (error.code !== 'EPERM') throw error; }
        }
        ids.add(session.sessionId);
      }
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

  async capture(session) {
    return { path: session.file, offset: session._end, seq: session._seq };
  }

  async deliver(session, text, id) {
    if (!this.heartbeat(session.rawId)) {
      throw new DeliveryError('The standalone messenger plugin is not running in this session.');
    }
    return this.store.enqueue(session.rawId, id, text, { asUser: false });
  }

  async read(session, message) {
    const { state, reason } = this.store.receipt(session.rawId, message.id, message.state);
    if (state === 'refused') return { state, reason };
    if (!session.file) return { state, reason: 'Transcript not available yet. An explicit send_message reply still works.' };

    let matched = false, done = false, answer = null, turn = null, activeTurn = null;
    const anchor = message.anchor || {};
    const startOffset = session.file === anchor.path ? anchor.offset || 0 : 0;
    for await (const { value: v } of readRecords(session.file, startOffset)) {
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
        } else if (matched && v.type === 'system' && ['turn_duration', 'stop_hook_summary'].includes(v.subtype)) {
          done = true;
        }
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

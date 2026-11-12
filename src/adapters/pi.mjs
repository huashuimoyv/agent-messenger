// Pi coding agent session discovery, transcript reader and delivery adapter.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { canonical, rawId, entries, jsonLines, headRecords, tailOffset, textContent, DeliveryError, envelopeMessageId } from '../io.mjs';
import { FileChannel } from '../channel-store.mjs';

function cleanProject(dirName) {
  if (!dirName) return null;
  const s = dirName.replace(/^--|--$/g, '');
  if (/^[A-Za-z]--/.test(s)) {
    return `${s[0].toUpperCase()}:${path.sep}${s.slice(3).replace(/-/g, path.sep)}`;
  }
  return path.sep + s.replace(/-/g, path.sep);
}

function findPiCliScript(config) {
  if (config.piCli && fs.existsSync(config.piCli)) return path.resolve(config.piCli);
  if (!config.piAutoSpawn) return null;
  const dirs = String(process.env.PATH || '').split(path.delimiter);
  for (const dir of dirs) {
    if (!dir) continue;
    for (const candidate of [
      path.join(dir, 'node_modules', '@earendil-works', 'pi-coding-agent', 'dist', 'cli.js'),
      path.join(path.dirname(dir), 'lib', 'node_modules', '@earendil-works', 'pi-coding-agent', 'dist', 'cli.js'),
    ]) {
      try { if (fs.statSync(candidate).isFile()) return candidate; } catch {}
    }
  }
  return null;
}

export class PiAdapter {
  #headerCache = new Map();

  constructor(config) {
    this.config = config;
    this.client = 'pi';
    this.replyTool = 'mcp__agent_messenger__send_message';
    this.canStart = true;
    this.piHome = config.piHome || path.join(config.home, '.pi', 'agent');
    this.sessionsDir = path.join(this.piHome, 'sessions');
    this.channel = config.piChannel || path.join(config.data, 'pi-channel');
    this.store = new FileChannel(this.channel);
    this.cliScript = findPiCliScript(config);
    this.launch = config.spawn || spawn;
  }

  identifyCaller({ env, ppid }) {
    if (env.PI_SESSION_ID) return { client: 'pi', rawId: rawId('pi', env.PI_SESSION_ID), turnId: null };
    const found = this.store.callerByPid(ppid, { fallbackSingleActive: true });
    return found ? { client: 'pi', rawId: found, turnId: null } : null;
  }

  heartbeat(id) {
    return this.store.heartbeat(rawId('pi', id));
  }

  watchPaths(session, record) {
    const file = session?._file || (session?.rawId ? this.findSessionFile(session.rawId) : null);
    return [file, ...this.store.watchTargets(session?.rawId, record?.id)].filter(Boolean);
  }

  findSessionFile(id) {
    if (!fs.existsSync(this.sessionsDir)) return null;
    const targetId = rawId('pi', id);
    for (const folder of entries(this.sessionsDir).filter(e => e.isDirectory())) {
      const dir = path.join(this.sessionsDir, folder.name);
      for (const entry of entries(dir).filter(e => e.isFile() && e.name.endsWith('.jsonl'))) {
        if (entry.name.includes(targetId)) return path.join(dir, entry.name);
      }
    }
    return null;
  }

  async parseHeaderAndTitle(filePath, folderName, stat = null) {
    try {
      stat ||= fs.statSync(filePath);
      const cached = this.#headerCache.get(filePath);
      if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) return cached.parsed;

      let id = null, cwd = null, title = null;
      const head = await headRecords(filePath, 32 * 1024, 15);
      for (const value of head) {
        if (value.type === 'session' && value.id) {
          id = value.id;
          cwd = value.cwd || null;
        } else if (value.type === 'message' && value.message?.role === 'user' && !title) {
          const text = textContent(value.message.content);
          if (text) title = text.replace(/[\r\n\[\]]/g, ' ').slice(0, 60).trim();
        }
        if (id && title) break;
      }
      if (!id) {
        const match = path.basename(filePath).match(/([0-9a-f-]{36})\.jsonl$/i);
        id = match ? match[1] : path.basename(filePath, '.jsonl');
      }
      const parsed = { id, project: cwd || cleanProject(folderName), title: title || id };
      this.#headerCache.set(filePath, { mtimeMs: stat.mtimeMs, size: stat.size, parsed });
      return parsed;
    } catch {
      return null;
    }
  }

  #buildSession(parsed, filePath, mtimeMs) {
    const st = this.store.status(parsed.id);
    const reachable = st.live ? true : st.present ? false : null;
    return {
      id: canonical('pi', parsed.id),
      rawId: parsed.id,
      client: 'pi',
      title: parsed.title,
      project: parsed.project,
      state: st.live ? (st.live.state || 'idle') : 'idle',
      reachable,
      ...(reachable === false ? { reason: 'This Pi session has ended or its agent-messenger extension is not running.' } : {}),
      updatedAt: mtimeMs,
      _file: filePath,
    };
  }

  async list({ limit = 30, offset = 0 } = {}) {
    if (!fs.existsSync(this.sessionsDir)) return [];
    const files = [];
    for (const folder of entries(this.sessionsDir).filter(e => e.isDirectory())) {
      const dir = path.join(this.sessionsDir, folder.name);
      for (const entry of entries(dir).filter(e => e.isFile() && e.name.endsWith('.jsonl'))) {
        const fullPath = path.join(dir, entry.name);
        try {
          const stat = fs.statSync(fullPath);
          files.push({ file: fullPath, folderName: folder.name, stat });
        } catch {}
      }
    }
    files.sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs);

    const sessions = [];
    for (const item of files.slice(offset, offset + limit)) {
      const parsed = await this.parseHeaderAndTitle(item.file, item.folderName, item.stat);
      if (parsed) sessions.push(this.#buildSession(parsed, item.file, item.stat.mtimeMs));
    }
    return sessions;
  }

  async get(id) {
    const raw = rawId('pi', id);
    const file = this.findSessionFile(raw);
    if (!file) return null;
    const stat = fs.statSync(file);
    const parsed = await this.parseHeaderAndTitle(file, path.basename(path.dirname(file)), stat);
    return parsed ? this.#buildSession(parsed, file, stat.mtimeMs) : null;
  }

  async capture(session) {
    const file = session._file || this.findSessionFile(session.rawId);
    if (!file || !fs.existsSync(file)) return { offset: 0, line: 0 };
    return { offset: fs.statSync(file).size, file };
  }

  async deliver(session, text, id) {
    const st = this.store.status(session.rawId);
    if (st.present && !st.live) {
      throw new DeliveryError('This Pi session has ended or its agent-messenger extension is not running.');
    }
    return this.store.enqueue(session.rawId, id, text);
  }

  async read(session, message, optionalAnchor) {
    const targetMessageId = typeof message === 'string' ? message : message?.id;
    const anchor = optionalAnchor || (typeof message === 'object' ? message?.anchor : null) || {};
    const file = session._file || this.findSessionFile(session.rawId);
    const { state, reason } = this.store.receipt(session.rawId, targetMessageId, message?.state || 'queued');
    if (state === 'refused') return { state, reason };
    if (!file || !fs.existsSync(file)) return { state, answer: null };

    const startOffset = anchor?.offset || 0;
    let matchedTurn = false, finalAnswer = null, explicitReplyId = null;
    for await (const { value } of jsonLines(file, startOffset)) {
      if (value.type !== 'message') continue;
      const msg = value.message;
      if (msg?.role === 'user') {
        const text = textContent(msg.content);
        if (envelopeMessageId(text) === targetMessageId) matchedTurn = true;
        else if (matchedTurn) break;
      } else if (matchedTurn && msg?.role === 'assistant') {
        const text = textContent(msg.content);
        if (text) {
          finalAnswer = text;
          const replyMatch = text.match(/\[Agent Messenger · [^\]]*?re (m-[A-Za-z0-9_-]+)\]/);
          if (replyMatch) explicitReplyId = replyMatch[1];
        }
      }
    }

    if (explicitReplyId) return { state: 'replied', answer: finalAnswer, replyId: explicitReplyId };
    if (finalAnswer !== null) return { state: 'done', answer: finalAnswer };
    if (['refused', 'expired'].includes(state) && !matchedTurn) return { state, reason, answer: null };
    return { state: matchedTurn ? 'started' : (state === 'queued' ? 'queued' : 'started'), answer: null };
  }

  async start(folder, text, id) {
    const sessionId = randomUUID();
    const now = new Date();
    const timestampStr = now.toISOString().replace(/[:.]/g, '-');
    const folderName = '--' + folder.replace(/^([A-Za-z]):/, '$1-').replace(/[\/\\]/g, '-') + '--';
    const targetDir = path.join(this.sessionsDir, folderName);
    fs.mkdirSync(targetDir, { recursive: true });

    const sessionFile = path.join(targetDir, `${timestampStr}_${sessionId}.jsonl`);
    const header = JSON.stringify({ type: 'session', version: 3, id: sessionId, timestamp: now.toISOString(), cwd: folder }) + '\n';
    fs.writeFileSync(sessionFile, header, 'utf8');

    let deliveryState = 'queued', reason = null;
    if (this.cliScript && fs.existsSync(folder)) {
      const ts = Date.now();
      this.store.enqueue(sessionId, id, text, { takenAt: ts, startedAt: ts });
      try {
        const child = this.launch(process.execPath, [this.cliScript, '--session', sessionFile, '--print', '--', text], {
          cwd: folder,
          stdio: 'ignore',
          detached: true,
          windowsHide: true,
        });
        child.unref?.();
        deliveryState = 'started';
      } catch (error) {
        deliveryState = 'uncertain';
        reason = `Created session file, but failed to launch headless Pi process: ${error.message}`;
      }
    } else {
      this.store.enqueue(sessionId, id, text);
    }

    return {
      id: canonical('pi', sessionId),
      rawId: sessionId,
      client: 'pi',
      project: folder,
      anchor: { offset: Buffer.byteLength(header, 'utf8'), file: sessionFile },
      deliveryState,
      ...(reason ? { reason } : {}),
    };
  }

  async current(caller) {
    const file = caller._file || this.findSessionFile(caller.rawId);
    if (!file || !fs.existsSync(file)) return null;
    const start = await tailOffset(file, 256 * 1024);
    let lastUserText = null;
    for await (const { value } of jsonLines(file, start)) {
      if (value.type === 'message' && value.message?.role === 'user') {
        const text = textContent(value.message.content);
        if (text) lastUserText = text;
      }
    }
    if (!lastUserText && start > 0) {
      for await (const { value } of jsonLines(file, 0)) {
        if (value.type === 'message' && value.message?.role === 'user') {
          const text = textContent(value.message.content);
          if (text) lastUserText = text;
        }
      }
    }
    return lastUserText ? { text: lastUserText } : null;
  }
}

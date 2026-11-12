// Pi coding agent session discovery, transcript reader and delivery adapter.
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { canonical, rawId, validName, entries, readJson, atomicJson, jsonLines, textContent, DeliveryError, envelopeMessageId } from '../io.mjs';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function cleanProject(dirName) {
  if (!dirName) return null;
  // Pi encodes path by stripping leading slash and replacing /, \, : with -
  // e.g. --E--Ameath-- -> E:\Ameath
  let s = dirName.replace(/^--|--$/g, '');
  if (/^[A-Za-z]--/.test(s)) {
    // Windows drive: E--Ameath -> E:\Ameath
    const drive = s[0].toUpperCase();
    const rest = s.slice(3).replace(/-/g, path.sep);
    return `${drive}:${path.sep}${rest}`;
  }
  return path.sep + s.replace(/-/g, path.sep);
}

export class PiAdapter {
  constructor(config, options = {}) {
    this.config = config;
    this.client = 'pi';
    this.piHome = config.piHome || path.join(config.home, '.pi', 'agent');
    this.sessionsDir = path.join(this.piHome, 'sessions');
    this.channel = config.piChannel || path.join(config.data, 'pi-channel');

    // Clean old prompts in channel
    try {
      const cutoff = Date.now() - 7 * 86400000;
      const promptsDir = path.join(this.channel, 'prompts');
      if (fs.existsSync(promptsDir)) {
        for (const folder of entries(promptsDir).filter(e => e.isDirectory())) {
          for (const entry of entries(path.join(promptsDir, folder.name)).filter(e => e.isFile() && e.name.endsWith('.json'))) {
            const file = path.join(promptsDir, folder.name, entry.name);
            if (fs.statSync(file).mtimeMs < cutoff) fs.rmSync(file, { force: true });
          }
        }
      }
    } catch {}
  }

  heartbeat(id) {
    const file = path.join(this.channel, 'sessions', `${id}.json`);
    const value = readJson(file);
    return value && !value.ended && Date.now() - fs.statSync(file).mtimeMs < 20000 ? value : null;
  }

  findSessionFile(id) {
    if (!fs.existsSync(this.sessionsDir)) return null;
    const targetId = rawId('pi', id);
    for (const folder of entries(this.sessionsDir).filter(e => e.isDirectory())) {
      for (const entry of entries(path.join(this.sessionsDir, folder.name)).filter(e => e.isFile() && e.name.endsWith('.jsonl'))) {
        if (entry.name.includes(targetId)) {
          return path.join(this.sessionsDir, folder.name, entry.name);
        }
      }
    }
    return null;
  }

  async list({ limit = 30, offset = 0 } = {}) {
    const sessions = [];
    if (!fs.existsSync(this.sessionsDir)) return sessions;

    const files = [];
    for (const folder of entries(this.sessionsDir).filter(e => e.isDirectory())) {
      for (const entry of entries(path.join(this.sessionsDir, folder.name)).filter(e => e.isFile() && e.name.endsWith('.jsonl'))) {
        const fullPath = path.join(this.sessionsDir, folder.name, entry.name);
        try {
          files.push({ file: fullPath, folderName: folder.name, mtimeMs: fs.statSync(fullPath).mtimeMs });
        } catch {}
      }
    }

    files.sort((a, b) => b.mtimeMs - a.mtimeMs);

    for (const item of files.slice(offset, offset + limit)) {
      const parsed = await this.parseHeaderAndTitle(item.file, item.folderName);
      if (!parsed) continue;

      const live = this.heartbeat(parsed.id);
      sessions.push({
        id: canonical('pi', parsed.id),
        rawId: parsed.id,
        client: 'pi',
        title: parsed.title,
        project: parsed.project,
        state: live ? (live.state || 'idle') : 'idle',
        reachable: live ? true : null,
        updatedAt: item.mtimeMs,
        _file: item.file
      });
    }

    return sessions;
  }

  async parseHeaderAndTitle(filePath, folderName) {
    try {
      let id = null, cwd = null, title = null, lineCount = 0;
      for await (const { value } of jsonLines(filePath, 0)) {
        lineCount++;
        if (value.type === 'session' && value.id) {
          id = value.id;
          cwd = value.cwd || null;
        }
        if (value.type === 'message' && value.message?.role === 'user' && !title) {
          const content = value.message.content;
          const text = textContent(content);
          if (text) {
            title = text.replace(/[\r\n\[\]]/g, ' ').slice(0, 60).trim();
          }
        }
        if (lineCount > 15 && title) break;
      }

      if (!id) {
        // Fallback from filename: 2026-10-03T15-42-12-348Z_<uuid>.jsonl
        const match = path.basename(filePath).match(/([0-9a-f-]{36})\.jsonl$/i);
        id = match ? match[1] : path.basename(filePath, '.jsonl');
      }

      return {
        id,
        project: cwd || cleanProject(folderName),
        title: title || id
      };
    } catch {
      return null;
    }
  }

  async get(id) {
    const raw = rawId('pi', id);
    const file = this.findSessionFile(raw);
    if (!file) return null;

    const parsed = await this.parseHeaderAndTitle(file, path.basename(path.dirname(file)));
    if (!parsed) return null;

    const live = this.heartbeat(raw);
    return {
      id: canonical('pi', raw),
      rawId: raw,
      client: 'pi',
      title: parsed.title,
      project: parsed.project,
      state: live ? (live.state || 'idle') : 'idle',
      reachable: live ? true : null,
      updatedAt: fs.statSync(file).mtimeMs,
      _file: file
    };
  }

  async capture(session) {
    const file = session._file || this.findSessionFile(session.rawId);
    if (!file || !fs.existsSync(file)) return { offset: 0, line: 0 };
    return {
      offset: fs.statSync(file).size,
      file
    };
  }

  async deliver(session, text, id, anchor) {
    // Write prompt into channel prompts queue
    const promptsDir = path.join(this.channel, 'prompts', session.rawId);
    const targetFile = path.join(promptsDir, `${id}.json`);
    atomicJson(targetFile, {
      id,
      text,
      at: Date.now(),
      expiresAt: Date.now() + 3600000 // 1 hour expiration
    });
    return { state: 'queued' };
  }

  async read(session, message, optionalAnchor) {
    const targetMessageId = typeof message === 'string' ? message : message?.id;
    const anchor = optionalAnchor || (typeof message === 'object' ? message?.anchor : null) || {};
    const file = session._file || this.findSessionFile(session.rawId);

    // Check prompt receipt in channel
    const receipt = readJson(path.join(this.channel, 'prompts', session.rawId, `${targetMessageId}.json`));
    let state = receipt?.refused ? 'refused' : receipt?.expiredAt ? 'expired' : receipt?.startedAt ? 'started' : receipt?.takenAt ? 'taken' : (message?.state || 'queued');
    if (receipt?.text && receipt.expiresAt <= Date.now()) state = 'expired';
    if (state === 'refused') return { state, reason: receipt.refused };

    if (!file || !fs.existsSync(file)) {
      return { state, answer: null };
    }

    const startOffset = anchor?.offset || 0;
    let matchedTurn = false;
    let finalAnswer = null;
    let explicitReplyId = null;

    for await (const { value } of jsonLines(file, startOffset)) {
      if (value.type === 'message') {
        const msg = value.message;
        if (msg?.role === 'user') {
          const text = textContent(msg.content);
          const incomingId = envelopeMessageId(text);
          if (incomingId === targetMessageId) {
            matchedTurn = true;
          } else if (matchedTurn) {
            // Next user turn started
            break;
          }
        } else if (matchedTurn && msg?.role === 'assistant') {
          const text = textContent(msg.content);
          if (text) {
            finalAnswer = text;
            const replyMatch = text.match(/\[Agent Messenger · [^\]]*?re (m-[A-Za-z0-9_-]+)\]/);
            if (replyMatch) explicitReplyId = replyMatch[1];
          }
        }
      }
    }

    if (explicitReplyId) {
      return { state: 'replied', answer: finalAnswer, replyId: explicitReplyId };
    }
    if (finalAnswer !== null) {
      return { state: 'done', answer: finalAnswer };
    }
    return { state: state === 'queued' ? 'queued' : 'started', answer: null };
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

    // Deliver first prompt
    const promptsDir = path.join(this.channel, 'prompts', sessionId);
    atomicJson(path.join(promptsDir, `${id}.json`), {
      id,
      text,
      at: Date.now(),
      expiresAt: Date.now() + 3600000
    });

    return {
      id: canonical('pi', sessionId),
      rawId: sessionId,
      client: 'pi',
      project: folder,
      anchor: { offset: Buffer.byteLength(header, 'utf8'), file: sessionFile },
      deliveryState: 'queued'
    };
  }

  async current(caller, turnId) {
    const file = caller._file || this.findSessionFile(caller.rawId);
    if (!file || !fs.existsSync(file)) return null;

    let lastUserText = null;
    for await (const { value } of jsonLines(file, 0)) {
      if (value.type === 'message' && value.message?.role === 'user') {
        const text = textContent(value.message.content);
        if (text) lastUserText = text;
      }
    }
    return lastUserText ? { text: lastUserText } : null;
  }
}

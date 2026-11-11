import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { StringDecoder } from 'node:string_decoder';
import { DatabaseSync } from 'node:sqlite';
import { Decompress } from 'fzstd';
import { canonical, rawId, jsonLines, textContent, envelopeMessageId, DeliveryError } from '../io.mjs';
import { historyState, captureHistory, currentHistory, readHistory } from './codex-history.mjs';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const APP_SERVER_TIMEOUT = 12_000;
const TAIL_BYTES = 2 * 1024 * 1024;

function fileExists(file) {
  try { return fs.statSync(file).isFile(); }
  catch { return false; }
}

function nativeFromPackage(root) {
  const packageName = process.arch === 'arm64' ? 'codex-win32-arm64' : 'codex-win32-x64';
  const triple = process.arch === 'arm64' ? 'aarch64-pc-windows-msvc' : 'x86_64-pc-windows-msvc';
  const candidates = [
    path.join(root, 'node_modules', '@openai', packageName, 'vendor', triple, 'bin', 'codex.exe'),
    path.join(path.dirname(root), packageName, 'vendor', triple, 'bin', 'codex.exe'),
    path.join(root, 'vendor', triple, 'bin', 'codex.exe'),
  ];
  return candidates.find(fileExists) || null;
}

function findExecutable(config) {
  if (process.platform !== 'win32') return config.codexExecutable || null;
  const explicit = config.codexExecutable;
  if (explicit && path.extname(explicit).toLowerCase() === '.exe' && fileExists(explicit)) return path.resolve(explicit);

  const folders = explicit ? [path.dirname(path.resolve(explicit))] : String(process.env.PATH || '').split(path.delimiter);
  for (const folder of folders) {
    if (!folder) continue;
    const direct = path.join(folder, 'codex.exe');
    if (fileExists(direct)) return direct;
    const packageRoot = path.join(folder, 'node_modules', '@openai', 'codex');
    const found = nativeFromPackage(packageRoot);
    if (found) return found;
  }
  return null;
}

async function* zstdRecords(file, start = 0) {
  const decoder = new StringDecoder('utf8');
  let pending = '', byteOffset = 0, ready = [];
  const stream = new Decompress(chunk => {
    pending += decoder.write(Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength));
    let newline;
    while ((newline = pending.indexOf('\n')) !== -1) {
      const line = pending.slice(0, newline);
      pending = pending.slice(newline + 1);
      byteOffset += Buffer.byteLength(line) + 1;
      if (byteOffset > start && line.trim()) ready.push({ value: JSON.parse(line), offset: byteOffset });
    }
  });
  for await (const chunk of fs.createReadStream(file, { highWaterMark: 16 * 1024 })) {
    stream.push(chunk);
    yield* ready;
    ready = [];
  }
}

async function* records(file, start = 0) {
  if (file.endsWith('.zst')) {
    yield* zstdRecords(file, start);
    return;
  }
  yield* jsonLines(file, start);
}

async function safeEndOffset(file) {
  if (!file || !fs.existsSync(file)) return 0;
  if (file.endsWith('.zst')) {
    let end = 0;
    for await (const row of records(file)) end = row.offset;
    return end;
  }
  const handle = await fsp.open(file, 'r');
  try {
    let position = (await handle.stat()).size;
    const bufferSize = 64 * 1024;
    while (position > 0) {
      const start = Math.max(0, position - bufferSize);
      const buffer = Buffer.allocUnsafe(position - start);
      await handle.read(buffer, 0, buffer.length, start);
      const newline = buffer.lastIndexOf(0x0a);
      if (newline !== -1) return start + newline + 1;
      position = start;
    }
    return 0;
  } finally { await handle.close(); }
}

async function tailStart(file) {
  const handle = await fsp.open(file, 'r');
  try {
    const size = (await handle.stat()).size;
    let position = Math.max(0, size - TAIL_BYTES);
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
  } finally { await handle.close(); }
}

function eventType(value) {
  return value?.type === 'event_msg' ? value.payload?.type : null;
}

function stateFromLifecycle(file) {
  return (async () => {
    if (!file || file.endsWith('.zst') || !fs.existsSync(file)) return 'unknown';
    const start = await tailStart(file);
    let active = null, sawTerminal = false;
    for await (const { value } of records(file, start)) {
      const type = eventType(value), payload = value.payload || {};
      if (type === 'task_started') active = payload.turn_id || true;
      if (type === 'task_complete' || type === 'turn_aborted') {
        const id = payload.turn_id;
        if (!active || active === true || !id || id === active) {
          active = null;
          sawTerminal = true;
        }
      }
    }
    return active ? 'running' : sawTerminal ? 'idle' : 'unknown';
  })();
}

function userPrompt(value) {
  const payload = value?.payload || {};
  if (value?.type === 'response_item' && payload.type === 'message' && payload.role === 'user')
    return textContent(payload.content);
  if (value?.type === 'event_msg' && payload.type === 'user_message')
    return typeof payload.message === 'string' ? payload.message : '';
  if (value?.type === 'event_msg' && payload.type === 'item_completed' && payload.item?.type === 'UserMessage')
    return textContent(payload.item.content);
  if (value?.type === 'message' && value.role === 'user')
    return textContent(value.content ?? value.message?.content);
  return '';
}

function finalAssistantText(value) {
  const payload = value?.payload || {};
  const type = eventType(value);
  if (type === 'task_complete' && typeof payload.last_agent_message === 'string')
    return payload.last_agent_message;
  if (type === 'agent_message' && (payload.phase === 'final_answer' || payload.channel === 'final'))
    return typeof payload.message === 'string' ? payload.message : '';
  if (type === 'item_completed' && payload.item?.type === 'AgentMessage' && payload.item.phase === 'final_answer')
    return textContent(payload.item.content);
  if (value?.type === 'response_item' && payload.type === 'message' && payload.role === 'assistant' && payload.phase === 'final_answer')
    return textContent(payload.content);
  return '';
}

class ServerRejection extends Error {}

function waitFor(promise, milliseconds, transportFailure = null) {
  let timer;
  const waiting = [promise];
  if (transportFailure) waiting.push(transportFailure);
  waiting.push(new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Codex app-server timed out.')), milliseconds); }));
  return Promise.race(waiting).finally(() => clearTimeout(timer));
}

function writeLine(child, value) {
  return new Promise((resolve, reject) => {
    child.stdin.write(`${JSON.stringify(value)}\n`, error => error ? reject(error) : resolve());
  });
}

async function appServer(executable, codexHome, launch, action) {
  let child, lines, rejectTransport;
  const transportFailure = new Promise((_, reject) => { rejectTransport = reject; });
  transportFailure.catch(() => {});
  try {
    child = launch(executable, ['app-server', '--listen', 'stdio://'], {
      env: { ...process.env, CODEX_HOME: codexHome },
      stdio: ['pipe', 'pipe', 'ignore'],
      windowsHide: true,
    });
    child.on('error', () => rejectTransport(new Error('Codex app-server process failed.')));
    child.once('exit', () => rejectTransport(new Error('Codex app-server exited before replying.')));
    if (child.stdin) child.stdin.on('error', () => rejectTransport(new Error('Codex app-server input pipe failed.')));
    if (!child.stdin || !child.stdout) throw new Error('Codex app-server could not be started.');
    lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
    const iterator = lines[Symbol.asyncIterator]();
    let nextId = 0;
    const request = async (method, params, mutation = false) => {
      const id = ++nextId;
      let attempted = false;
      try {
        attempted = true;
        const deadline = Date.now() + APP_SERVER_TIMEOUT;
        await waitFor(writeLine(child, { id, method, params }), deadline - Date.now(), transportFailure);
        for (;;) {
          const remaining = deadline - Date.now();
          if (remaining <= 0) throw new Error('Codex app-server timed out.');
          const next = await waitFor(iterator.next(), remaining, transportFailure);
          if (next.done) throw new Error('Codex app-server closed before replying.');
          let value;
          try { value = JSON.parse(next.value); }
          catch { throw new Error('Codex app-server returned invalid JSON.'); }
          if (value.method || value.id !== id) continue;
          if (value.error) throw new ServerRejection(value.error.message || 'Codex rejected the request.');
          if (!value.result || typeof value.result !== 'object') throw new Error('Codex app-server returned no result.');
          return value.result;
        }
      } catch (error) {
        if (error instanceof ServerRejection) throw new DeliveryError(error.message, 'refused');
        throw new DeliveryError(error.message, mutation && attempted ? 'uncertain' : 'refused');
      }
    };
    await request('initialize', {
      clientInfo: { name: 'agent_messenger', title: 'Agent Messenger', version: '0.1.0' },
      capabilities: { experimentalApi: true },
    });
    await waitFor(writeLine(child, { method: 'initialized' }), APP_SERVER_TIMEOUT, transportFailure);
    return await action(request);
  } catch (error) {
    if (error instanceof DeliveryError) throw error;
    throw new DeliveryError(error.message || 'Could not start Codex app-server.');
  } finally {
    lines?.close();
    if (child && child.exitCode === null && child.signalCode === null) {
      const stopped = new Promise(resolve => child.once('exit', resolve));
      child.stdin?.end();
      await waitFor(stopped, 1500).catch(() => child.kill());
    }
  }
}

function openDesktop(url, launch = spawn) {
  if (process.platform !== 'win32') return Promise.resolve(false);
  return new Promise(resolve => {
    let settled = false;
    const finish = value => { if (!settled) { settled = true; clearTimeout(timer); resolve(value); } };
    const timer = setTimeout(() => finish(false), 2500);
    try {
      const child = launch(path.join(process.env.SystemRoot, 'System32', 'rundll32.exe'), ['url.dll,FileProtocolHandler', url], { windowsHide: true, stdio: 'ignore' });
      child.once('exit', code => finish(code === 0));
      child.once('error', () => finish(false));
    } catch { finish(false); }
  });
}

async function wakeDesktop(config, threadId, launch) {
  try {
    const url = `codex://threads/wake/${threadId}`;
    const opened = config.openUrl ? await config.openUrl(url) : await openDesktop(url, launch);
    return opened ? null : 'Queued; the Codex app could not be opened automatically.';
  } catch {
    return 'Queued; the Codex app could not be opened automatically.';
  }
}

function sqliteRows(home, sql, params = []) {
  const database = new DatabaseSync(path.join(home, 'state_5.sqlite'), { readOnly: true });
  try {
    database.exec('PRAGMA query_only=ON');
    return database.prepare(sql).all(...params);
  } finally { database.close(); }
}

function rolloutPath(home, value) {
  if (!value) return null;
  return path.isAbsolute(value) ? value : path.resolve(home, value);
}

export class CodexAdapter {
  constructor(config) {
    this.config = config;
    this.client = 'codex';
    this.executable = findExecutable(config);
    this.launch = config.spawn || spawn;
  }

  #session(row) {
    const raw = String(row.id).toLowerCase();
    const project = row.cwd || null;
    return {
      id: canonical(this.client, raw), rawId: raw, client: this.client,
      title: row.title || (project ? path.basename(project) : 'Codex session'),
      project, state: 'unknown', reachable: Boolean(this.executable),
      reason: this.executable ? null : 'Codex executable was not found.',
      updatedAt: Number(row.updated_at_ms || Number(row.updated_at || 0) * 1000),
      file: rolloutPath(this.config.codexHome, row.rollout_path),
      historyMode: row.history_mode,
    };
  }

  async list({ limit = 50, offset = 0 } = {}) {
    if (!fs.existsSync(path.join(this.config.codexHome, 'state_5.sqlite'))) return [];
    const rows = sqliteRows(this.config.codexHome,
      `SELECT id, rollout_path, updated_at, updated_at_ms, cwd, title, history_mode
       FROM threads WHERE archived=0 AND agent_role IS NULL AND agent_nickname IS NULL
         AND (NOT json_valid(source) OR json_type(source, '$.subagent') IS NULL)
       ORDER BY updated_at_ms DESC, updated_at DESC LIMIT ? OFFSET ?`, [limit, offset]);
    const sessions = [];
    for (const row of rows) {
      const session = this.#session(row);
      session.state = session.historyMode === 'paginated' ? historyState(this.config.codexHome, session.rawId) : await stateFromLifecycle(session.file);
      sessions.push(session);
    }
    return sessions;
  }

  async get(id) {
    const raw = rawId(this.client, String(id)).toLowerCase();
    if (!UUID.test(raw) || !fs.existsSync(path.join(this.config.codexHome, 'state_5.sqlite'))) return null;
    const [row] = sqliteRows(this.config.codexHome,
      `SELECT id, rollout_path, updated_at, updated_at_ms, cwd, title, history_mode
       FROM threads WHERE id=? AND agent_role IS NULL AND agent_nickname IS NULL
         AND (NOT json_valid(source) OR json_type(source, '$.subagent') IS NULL) LIMIT 1`, [raw]);
    if (!row) return null;
    const session = this.#session(row);
    session.state = session.historyMode === 'paginated' ? historyState(this.config.codexHome, session.rawId) : await stateFromLifecycle(session.file);
    return session;
  }

  async capture(session) {
    if (session.historyMode === 'paginated') return captureHistory(this.config.codexHome, session.rawId);
    const file = session.file && fs.existsSync(session.file) ? session.file : null;
    return { path: file, offset: file ? await safeEndOffset(file) : 0 };
  }

  async deliver(session, text, messageId) {
    if (!this.executable) throw new DeliveryError('Codex executable was not found.');
    if (!UUID.test(session.rawId)) throw new DeliveryError('Invalid Codex thread id.');
    const result = await appServer(this.executable, this.config.codexHome, this.launch, request =>
      request('thread/queue/add', {
        threadId: session.rawId,
        clientUserMessageId: `agent-messenger:${messageId}`,
        input: [{ type: 'text', text, text_elements: [] }],
      }, true));
    if (!result.queuedSubmission || typeof result.queuedSubmission !== 'object')
      return { state: 'uncertain', reason: 'Codex did not confirm that it queued the message.' };
    const reason = await wakeDesktop(this.config, session.rawId, this.launch);
    return { state: 'queued', ...(reason ? { reason } : {}) };
  }

  async read(session, message) {
    if (session.historyMode === 'paginated') return readHistory(this.config.codexHome, session, message);
    const anchor = message.anchor || {};
    const file = session.file && fs.existsSync(session.file) ? session.file : anchor.path;
    if (!file || !fs.existsSync(file)) return {};
    const start = file === anchor.path ? Number(anchor.offset || 0) : 0;
    let activeTurn = null, matchedTurn = null, finalText = '';
    for await (const { value } of records(file, start)) {
      const type = eventType(value), payload = value.payload || {};
      if (type === 'task_started') activeTurn = payload.turn_id || null;
      const prompt = userPrompt(value);
      if (prompt && envelopeMessageId(prompt) === message.id) matchedTurn = activeTurn || payload.turn_id || null;
      if (matchedTurn) {
        if ((payload.turn_id || activeTurn) === matchedTurn) {
          const final = finalAssistantText(value);
          if (final.trim()) finalText = final;
        }
        if (type === 'task_complete' && payload.turn_id === matchedTurn)
          return { state: 'done', answer: finalText || null, turn: matchedTurn };
        if (type === 'turn_aborted' && payload.turn_id === matchedTurn)
          return { state: 'done', answer: finalText || null, turn: matchedTurn, reason: 'Codex turn was aborted.' };
      }
      if ((type === 'task_complete' || type === 'turn_aborted') && (!activeTurn || !payload.turn_id || payload.turn_id === activeTurn))
        activeTurn = null;
    }
    return matchedTurn ? { state: 'started', turn: matchedTurn } : {};
  }

  async current(session, turnId = null) {
    if (session.historyMode === 'paginated') return currentHistory(this.config.codexHome, session.rawId, turnId);
    const file = session.file;
    if (!file || !fs.existsSync(file)) return null;
    let activeTurn = null, latest = null, selected = null;
    for await (const { value } of records(file)) {
      const type = eventType(value), payload = value.payload || {};
      if (type === 'task_started') activeTurn = payload.turn_id || null;
      const prompt = userPrompt(value);
      if (prompt) {
        const id = activeTurn || payload.turn_id || null;
        const row = { text: prompt, turnId: id };
        latest = row;
        if (turnId && id === turnId) selected = row;
      }
    }
    return turnId ? selected : latest;
  }

  async start(folder, text, messageId) {
    if (!this.executable) throw new DeliveryError('Codex executable was not found.');
    if (!path.isAbsolute(folder) || !fs.statSync(folder).isDirectory())
      throw new DeliveryError('folder must be an existing absolute project directory.');
    const result = await appServer(this.executable, this.config.codexHome, this.launch, async request => {
      const started = await request('thread/start', { cwd: folder, ephemeral: false, historyMode: 'legacy' }, true);
      const raw = started.thread?.id;
      if (typeof raw !== 'string' || !UUID.test(raw))
        throw new DeliveryError('Codex did not return the new thread id.', 'uncertain');
      let session = {
        id: canonical(this.client, raw.toLowerCase()), rawId: raw.toLowerCase(), client: this.client,
        title: path.basename(folder), project: folder, state: 'unknown', reachable: true,
        file: rolloutPath(this.config.codexHome, started.thread.rolloutPath || started.thread.rollout_path),
      };
      try {
        // Like the upstream desktop start route, name the thread to persist it
        // before the creating app-server exits and another owner takes it.
        await request('thread/name/set', { threadId: raw, name: `Agent Messenger ${messageId}` }, true);
        session = await this.get(raw) || session;
        session.anchor = await this.capture(session);
      } catch {
        session.deliveryState = 'uncertain';
        session.reason = 'Codex created the thread, but its name or transcript was not confirmed before queueing.';
        return session;
      }
      return session;
    });
    if (result.deliveryState) return result;
    try {
      const queued = await appServer(this.executable, this.config.codexHome, this.launch, request =>
        request('thread/queue/add', {
          threadId: result.rawId,
          clientUserMessageId: `agent-messenger:${messageId}`,
          input: [{ type: 'text', text, text_elements: [] }],
        }, true));
        if (!queued.queuedSubmission || typeof queued.queuedSubmission !== 'object') {
          result.deliveryState = 'uncertain';
          result.reason = 'Codex did not confirm that it queued the first prompt.';
        } else {
          result.deliveryState = 'queued';
        }
      } catch (error) {
        result.deliveryState = error.state || 'uncertain';
        result.reason = error.message;
      }
    if (result.deliveryState === 'queued') {
      result.reason = await wakeDesktop(this.config, result.rawId, this.launch);
    }
    return result;
  }
}

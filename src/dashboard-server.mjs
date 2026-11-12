import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { jsonLines, textContent } from './io.mjs';
import { canTransition } from './journal.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const messageDetailsCache = new Map();

function cleanPrompt(raw) {
  if (!raw) return '';
  let text = String(raw).trim();
  text = text.replace(/^<USER_REQUEST>\s*/i, '').replace(/\s*<\/USER_REQUEST>$/i, '');
  text = text.replace(/^\[Agent Messenger · [^\]]+\]\s*/i, '');
  return text.trim();
}

function extractTitle(text, id) {
  if (!text) return id;
  const firstLine = text.split('\n')[0].trim();
  return firstLine.length > 50 ? firstLine.slice(0, 48) + '...' : firstLine;
}

function findUiIndex() {
  const candidates = [
    path.join(ROOT, 'ui', 'index.html'),
    path.join(__dirname, '..', 'ui', 'index.html'),
    path.join(process.cwd(), 'ui', 'index.html'),
    'E:\\Ameath\\agent-messenger\\ui\\index.html',
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return null;
}

async function resolveMessageDetails(record, adapterMap) {
  const cacheKey = `${record.id}:${record.state}:${record.replyId || ''}`;
  const cached = messageDetailsCache.get(cacheKey);
  if (cached) {
    return cached;
  }

  let text = '';
  let answer = '';
  let reason = record.reason || null;
  const anchor = typeof record.anchor === 'string' ? JSON.parse(record.anchor || '{}') : (record.anchor || {});

  const targetAdapter = adapterMap.get(record.toClient);
  const rawId = record.toId.includes(':') ? record.toId.split(':').slice(1).join(':') : record.toId;
  let sessionObj = null;

  try {
    if (targetAdapter?.get) {
      sessionObj = await targetAdapter.get(rawId);
    }
  } catch {}

  if (!sessionObj) {
    sessionObj = {
      id: record.toId,
      rawId,
      _file: anchor.path || anchor.file
    };
  }

  let readRes = null;
  try {
    if (record.toClient === 'antigravity' && anchor.path && fs.existsSync(anchor.path)) {
      for await (const { value } of jsonLines(anchor.path, anchor.offset || 0)) {
        if (value.type === 'USER_INPUT' && value.source !== 'SYSTEM') {
          const raw = typeof value.content === 'string' ? value.content : JSON.stringify(value.content);
          text = cleanPrompt(raw);
          break;
        }
      }
    } else if (record.toClient === 'pi') {
      const piAdapter = adapterMap.get('pi');
      const file = anchor.file || (piAdapter?.findSessionFile ? piAdapter.findSessionFile(rawId) : null);
      if (file && fs.existsSync(file)) {
        for await (const { value } of jsonLines(file, anchor.offset || 0)) {
          if (value.type === 'message' && value.message?.role === 'user') {
            const raw = textContent(value.message.content);
            text = cleanPrompt(raw);
            break;
          }
        }
      }
    }

    if (targetAdapter && targetAdapter.read && record.state !== 'refused') {
      readRes = await targetAdapter.read(sessionObj, { ...record, anchor });
      if (readRes) {
        if (readRes.answer) answer = readRes.answer.trim();
        if (readRes.reason && !reason) reason = readRes.reason;
      }
    }
  } catch (err) {
    // Ignore extraction errors gracefully
  }

  let effectiveState = record.state;
  if (readRes?.state && canTransition(record.state, readRes.state)) {
    effectiveState = readRes.state;
  }
  if (record.replyId || readRes?.replyId) {
    effectiveState = 'replied';
  }

  const result = {
    text: text || `[${record.kind}] ${record.fromClient} -> ${record.toClient}`,
    answer: answer || (effectiveState === 'refused' ? (reason || '请求被拒绝') : ''),
    title: extractTitle(text, record.id),
    state: effectiveState,
    reason
  };

  if (['done', 'replied', 'refused'].includes(effectiveState) && record.state === effectiveState) {
    messageDetailsCache.set(cacheKey, result);
  }

  return result;
}

export function startDashboardServer({ config, adapters, port = 3721, host = '127.0.0.1', unref = true } = {}) {
  if (process.env.AGENT_MESSENGER_DASHBOARD === '0') return null;

  const targetPort = Number(process.env.AGENT_MESSENGER_PORT) || port;
  const adapterMap = new Map((adapters || []).map(a => [a.client, a]));
  const sockets = new Set();

  async function getState() {
    const clientLatest = new Map();

    if (adapters && Array.isArray(adapters)) {
      for (const adapter of adapters) {
        try {
          const list = await adapter.list();
          for (const s of list) {
            let model = s.model || '';
            if (!model) {
              if (s.client === 'antigravity') model = 'Gemini 3.8 Flash';
              else if (s.client === 'codex') model = 'GPT-6.1 Sol';
              else if (s.client === 'pi') model = 'Gemini 4 Carbon';
            }

            const resolvedState = s.state === 'running' ? 'running'
              : s.state === 'idle' ? 'idle'
              : s.state === 'offline' ? 'offline'
              : (s.idle === false ? 'running' : s.idle === true ? 'idle' : (s.state || 'unknown'));

            const formatted = {
              id: s.id,
              client: s.client,
              model,
              workspace: s.project || s.workspace || '',
              state: resolvedState,
              reachable: s.reachable
            };

            const existing = clientLatest.get(s.client);
            if (!existing) {
              clientLatest.set(s.client, formatted);
            } else {
              const isCurrentWs = (formatted.workspace || '').toLowerCase().includes('ameath');
              const wasCurrentWs = (existing.workspace || '').toLowerCase().includes('ameath');
              if (isCurrentWs && !wasCurrentWs) {
                clientLatest.set(s.client, formatted);
              } else if (isCurrentWs === wasCurrentWs && formatted.state !== 'offline' && existing.state === 'offline') {
                clientLatest.set(s.client, formatted);
              }
            }
          }
        } catch (e) {}
      }
    }

    const sessions = [...clientLatest.values()];

    const dbPath = path.join(config.data, 'messages.sqlite');
    const messages = [];
    if (fs.existsSync(dbPath)) {
      const db = new DatabaseSync(dbPath);
      try {
        const rows = db.prepare('SELECT * FROM messages ORDER BY sentAt DESC LIMIT 60').all();
        for (const row of rows) {
          const details = await resolveMessageDetails(row, adapterMap);
          messages.push({
            id: row.id,
            fromClient: row.fromClient,
            toClient: row.toClient,
            sentAt: row.sentAt,
            chain: row.chain,
            pass: row.pass,
            kind: row.kind,
            replyTo: row.replyTo || undefined,
            replyId: row.replyId || undefined,
            state: details.state || row.state,
            title: details.title,
            text: details.text,
            answer: details.answer || undefined,
            reason: details.reason || undefined
          });
        }
      } finally {
        db.close();
      }
    }

    return {
      passLimit: config.passLimit || 10,
      sessions,
      messages
    };
  }

  const server = http.createServer(async (req, res) => {
    try {
      // Safe CORS: only permit localhost / 127.0.0.1 / [::1] origins
      const origin = req.headers.origin;
      if (origin) {
        try {
          const originUrl = new URL(origin);
          if (originUrl.hostname === 'localhost' || originUrl.hostname === '127.0.0.1' || originUrl.hostname === '[::1]') {
            res.setHeader('Access-Control-Allow-Origin', origin);
            res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
            res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
          }
        } catch {}
      }

      if (req.method === 'OPTIONS') {
        res.writeHead(204);
        res.end();
        return;
      }

      // Reject malformed Host header before URL processing
      if (req.headers.host) {
        try {
          new URL(`http://${req.headers.host}`);
        } catch {
          res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
          res.end('Bad Request');
          return;
        }
      }

      // Safe URL parsing with fixed local base
      let url;
      try {
        url = new URL(req.url, 'http://127.0.0.1:3721');
      } catch {
        res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('Bad Request');
        return;
      }

      if (url.pathname === '/api/state') {
        try {
          const state = await getState();
          res.writeHead(200, {
            'Content-Type': 'application/json; charset=utf-8',
            'Cache-Control': 'no-store'
          });
          res.end(JSON.stringify(state));
        } catch (err) {
          res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ error: err.message }));
        }
        return;
      }

      if (url.pathname === '/' || url.pathname === '/index.html') {
        const currentUi = findUiIndex();
        if (currentUi && fs.existsSync(currentUi)) {
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
          fs.createReadStream(currentUi).pipe(res);
        } else {
          res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
          res.end('ui/index.html not found');
        }
        return;
      }

      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Not Found');
    } catch (err) {
      try {
        res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('Internal Server Error');
      } catch {}
    }
  });

  server.on('connection', socket => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });

  server.on('error', err => {
    if (err.code === 'EADDRINUSE') {
      return;
    }
    process.stderr.write(`[Agent Messenger Dashboard Warning] ${err.message}\n`);
  });

  try {
    server.listen(targetPort, host, () => {
      if (unref) {
        server.unref();
      }
    });
  } catch {}

  return {
    server,
    unref,
    close: () => new Promise(r => {
      for (const s of sockets) {
        try { s.end(); } catch {}
      }
      setImmediate(() => {
        for (const s of sockets) {
          try { s.destroy(); } catch {}
        }
      });
      server.close(r);
    })
  };
}

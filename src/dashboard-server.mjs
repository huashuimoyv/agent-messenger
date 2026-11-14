import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { findReply } from './journal.mjs';
import { messageState } from './message-state.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

function extractTitle(text, id) {
  if (!text) return id;
  const firstLine = text.split('\n')[0].trim();
  return firstLine.length > 50 ? firstLine.slice(0, 48) + '...' : firstLine;
}

function findUiIndex() {
  const candidates = [
    path.join(__dirname, 'ui', 'index.html'),
    path.join(ROOT, 'ui', 'index.html'),
    path.join(process.cwd(), 'ui', 'index.html'),
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return null;
}

async function resolveMessageDetails(record, adapterMap, db) {
  const anchor = JSON.parse(record.anchor);
  const targetAdapter = adapterMap.get(record.toClient);
  const rawId = record.toId.slice(record.toClient.length + 1);
  let session = null, text = null, observed = {}, errorReason = null, targetMissing = false;
  try {
    session = await targetAdapter?.get?.(rawId);
    targetMissing = typeof targetAdapter?.get === 'function' && !session;
  } catch (error) {
    errorReason = `无法读取目标会话：${error.message}`;
  }
  const readableSession = session || {
    id: record.toId, rawId, file: anchor.path, _file: anchor.file || anchor.path,
    historyMode: anchor.historyMode,
  };
  try {
    text = await targetAdapter?.readPrompt?.(readableSession, { ...record, anchor }) ?? null;
  } catch (error) {
    errorReason = `无法读取原始正文：${error.message}`;
  }
  try {
    if (record.state !== 'refused') observed = await targetAdapter?.read?.(readableSession, { ...record, anchor }) || {};
  } catch (error) {
    errorReason = `无法读取消息回执：${error.message}`;
  }
  const status = messageState(record, observed, targetMissing ? { reachable: false } : session, findReply(db, record));
  const parent = record.replyTo ? db.prepare('SELECT fromId,toId FROM messages WHERE id=?').get(record.replyTo) : null;
  const forwarded = parent && (record.fromId !== parent.toId || record.toId !== parent.fromId);
  return {
    ...status,
    text,
    answer: observed.answer?.trim() || null,
    title: extractTitle(text, record.id),
    reason: errorReason || status.reason || (forwarded ? '该消息发往其他会话，未计作原发送者收到的回信。' : null),
  };
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
            const resolvedState = s.reachable === false ? 'offline'
              : s.state === 'running' ? 'running'
              : s.state === 'idle' ? 'idle'
              : s.state === 'offline' ? 'offline'
              : (s.idle === false ? 'running' : s.idle === true ? 'idle' : (s.state || 'unknown'));

            const formatted = {
              id: s.id,
              client: s.client,
              model: s.model || null,
              workspace: s.project || s.workspace || '',
              state: resolvedState,
              reachable: s.reachable
            };

            const existing = clientLatest.get(s.client);
            if (!existing) {
              clientLatest.set(s.client, formatted);
            } else {
              const previous = list.find(item => item.id === existing.id);
              if ((s.reachable === true && previous.reachable !== true)
                || (s.reachable === previous.reachable && (s.updatedAt || 0) > (previous.updatedAt || 0))) {
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
      const db = new DatabaseSync(dbPath, { readOnly: true });
      try {
        const rows = db.prepare('SELECT * FROM messages ORDER BY sentAt DESC LIMIT 60').all();
        for (const row of rows) {
          const details = await resolveMessageDetails(row, adapterMap, db);
          messages.push({
            id: row.id,
            fromClient: row.fromClient,
            toClient: row.toClient,
            fromId: row.fromId,
            toId: row.toId,
            sentAt: row.sentAt,
            chain: row.chain,
            pass: row.pass,
            kind: row.kind,
            replyTo: row.replyTo || undefined,
            replyId: details.replyId || undefined,
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

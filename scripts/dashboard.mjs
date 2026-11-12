#!/usr/bin/env node
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { configuration } from '../src/config.mjs';
import { createAdapters } from '../src/adapters/index.mjs';
import { jsonLines, textContent } from '../src/io.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const UI_INDEX = path.join(ROOT, 'ui', 'index.html');
const config = configuration();
const adapters = createAdapters(config);
const adapterMap = new Map(adapters.map(a => [a.client, a]));

const PORT = Number(process.env.PORT) || 3721;
const HOST = process.env.HOST || '127.0.0.1';

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

async function resolveMessageDetails(record) {
  const cacheKey = record.id;
  const cached = messageDetailsCache.get(cacheKey);
  if (cached && (record.state === 'done' || record.state === 'refused' || record.state === 'replied')) {
    return cached;
  }

  let text = '';
  let answer = '';
  let reason = record.reason || null;
  const anchor = typeof record.anchor === 'string' ? JSON.parse(record.anchor || '{}') : (record.anchor || {});

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
      const file = anchor.file || (piAdapter?.findSessionFile ? piAdapter.findSessionFile(record.toId.replace(/^pi:/, '')) : null);
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

    const targetAdapter = adapterMap.get(record.toClient);
    if (targetAdapter && targetAdapter.read && record.state !== 'refused') {
      const sessionObj = {
        id: record.toId,
        rawId: record.toId.includes(':') ? record.toId.split(':').slice(1).join(':') : record.toId,
        _file: anchor.path || anchor.file
      };
      const readRes = await targetAdapter.read(sessionObj, { ...record, anchor });
      if (readRes) {
        if (readRes.answer) answer = readRes.answer.trim();
        if (readRes.reason && !reason) reason = readRes.reason;
      }
    }
  } catch (err) {
    // Ignore extraction errors
  }

  const result = {
    text: text || `[${record.kind}] ${record.fromClient} -> ${record.toClient}`,
    answer: answer || (record.state === 'refused' ? (reason || '请求被拒绝') : ''),
    title: extractTitle(text, record.id),
    reason
  };

  if (record.state === 'done' || record.state === 'refused' || record.state === 'replied') {
    messageDetailsCache.set(cacheKey, result);
  }

  return result;
}

async function getState() {
  const clientLatest = new Map();

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

        const formatted = {
          id: s.id,
          client: s.client,
          model,
          workspace: s.project || s.workspace || '',
          state: s.idle === false ? 'running' : (s.reachable === false ? 'offline' : 'idle'),
          reachable: s.reachable !== false
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

  const topSessions = [];
  for (const client of ['antigravity', 'codex', 'pi']) {
    if (clientLatest.has(client)) {
      topSessions.push(clientLatest.get(client));
    } else {
      topSessions.push({
        id: `${client}:local`,
        client,
        model: client === 'antigravity' ? 'Gemini 3.8 Flash' : (client === 'codex' ? 'GPT-6.1 Sol' : 'Gemini 4 Carbon'),
        workspace: 'E:\\Ameath',
        state: 'idle',
        reachable: true
      });
    }
  }

  const dbPath = path.join(config.data, 'messages.sqlite');
  const messages = [];
  if (fs.existsSync(dbPath)) {
    const db = new DatabaseSync(dbPath);
    try {
      const rows = db.prepare('SELECT * FROM messages ORDER BY sentAt DESC LIMIT 60').all();
      for (const row of rows) {
        const details = await resolveMessageDetails(row);
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
          state: row.state,
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
    sessions: topSessions,
    messages
  };
}

const server = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

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
    if (fs.existsSync(UI_INDEX)) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      fs.createReadStream(UI_INDEX).pipe(res);
    } else {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('ui/index.html not found');
    }
    return;
  }

  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('Not Found');
});

server.listen(PORT, HOST, () => {
  const url = `http://${HOST}:${PORT}`;
  console.log(`[Agent Messenger Dashboard] Running at ${url}`);
  console.log(`- Web UI:    ${url}/`);
  console.log(`- API State: ${url}/api/state`);
});

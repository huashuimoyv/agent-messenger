import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Journal } from '../src/journal.mjs';
import { FileChannel } from '../src/channel-store.mjs';
import { startDashboardServer } from '../src/dashboard-server.mjs';
import { configuration } from '../src/config.mjs';

test('1. Malformed HTTP request with invalid Host returns 400 and does not crash process', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-fix-1-'));
  const config = { ...configuration(), data: root };
  const port = 3791;
  const instance = startDashboardServer({ config, adapters: [], port });
  t.after(async () => {
    await instance.close();
    fs.rmSync(root, { recursive: true, force: true });
  });

  await new Promise((resolve, reject) => {
    const client = net.createConnection({ port, host: '127.0.0.1' }, () => {
      client.write("GET /api/state HTTP/1.1\r\nHost: [\r\nConnection: close\r\n\r\n");
    });
    let data = '';
    client.on('data', chunk => { data += chunk.toString(); });
    client.on('end', () => {
      assert.match(data, /HTTP\/1\.1 400 Bad Request/);
      resolve();
    });
    client.on('error', reject);
  });
});

test('2. Journal protects terminal states (done/replied/refused) from being overwritten by expired/queued', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-fix-2-'));
  const journal = new Journal(root);
  t.after(() => {
    journal.close();
    fs.rmSync(root, { recursive: true, force: true });
  });

  const record = {
    id: 'm-audit-test-1',
    requestKey: 'test:audit:1',
    fingerprint: 'fp1',
    fromId: 'antigravity:1',
    toId: 'codex:1',
    fromClient: 'antigravity',
    toClient: 'codex',
    sentAt: Date.now(),
    chain: 'm-audit-test-1',
    pass: 1,
    kind: 'send',
    replyTo: null,
    replyId: null,
    state: 'done',
    reason: null,
    anchor: {},
  };
  journal.reserve(record);
  assert.equal(journal.get('m-audit-test-1').state, 'done');

  // Try to overwrite done with expired
  journal.update('m-audit-test-1', { state: 'expired', reason: 'late timeout' });
  assert.equal(journal.get('m-audit-test-1').state, 'done', 'done must not be overwritten by expired');

  // Try to overwrite done with queued
  journal.update('m-audit-test-1', { state: 'queued' });
  assert.equal(journal.get('m-audit-test-1').state, 'done', 'done must not be overwritten by queued');

  // Try to overwrite done with replied
  journal.update('m-audit-test-1', { state: 'replied' });
  assert.equal(journal.get('m-audit-test-1').state, 'replied', 'done can transition to replied');

  // Settle reply updates replyId and state can transition to replied
  const parent = {
    ...record,
    id: 'm-audit-parent',
    requestKey: 'test:parent:1',
    state: 'started',
  };
  journal.reserve(parent);
  journal.settleReply('m-audit-parent', 'm-reply-child');
  const settled = journal.get('m-audit-parent');
  assert.equal(settled.replyId, 'm-reply-child');
  journal.update('m-audit-parent', { state: 'replied' });
  assert.equal(journal.get('m-audit-parent').state, 'replied');
});

test('2b. FileChannel respects takenAt and startedAt, never falsely marking them expired', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-fix-2b-'));
  const store = new FileChannel(root);
  t.after(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  const rawId = 'test-session';
  const msgId = 'm-msg-1';
  // Create an expired prompt that was already taken and started
  const promptDir = path.join(root, 'prompts', rawId);
  fs.mkdirSync(promptDir, { recursive: true });
  fs.writeFileSync(path.join(promptDir, `${msgId}.json`), JSON.stringify({
    text: 'hello',
    expiresAt: Date.now() - 10_000, // expired in past
    takenAt: Date.now() - 5_000,
    startedAt: Date.now() - 4_000,
  }));

  const receipt = store.receipt(rawId, msgId);
  assert.equal(receipt.state, 'started', 'Already started prompt must not be marked expired');
});

test('3. Dashboard server closes active sockets on close()', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-fix-3-'));
  const config = { ...configuration(), data: root };
  const port = 3792;
  const instance = startDashboardServer({ config, adapters: [], port });
  t.after(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  // Open an idle keep-alive connection
  const socket = net.createConnection({ port, host: '127.0.0.1' });
  await new Promise(r => socket.once('connect', r));

  // Closing dashboard must terminate the socket immediately
  const socketClosedPromise = new Promise(r => socket.once('close', r));
  await instance.close();
  await socketClosedPromise;
});

test('4 & 6. Dashboard preserves real adapter states, rejects foreign CORS, and does not invent fake sessions', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-fix-4-'));
  const config = { ...configuration(), data: root };
  const port = 3793;

  const mockAdapter = {
    client: 'test-agent',
    list: async () => [
      {
        id: 'test-agent:123',
        client: 'test-agent',
        model: 'Custom Model 1',
        project: 'E:\\Ameath',
        state: 'running',
        reachable: null,
      }
    ]
  };

  const instance = startDashboardServer({ config, adapters: [mockAdapter], port });
  t.after(async () => {
    await instance.close();
    fs.rmSync(root, { recursive: true, force: true });
  });

  // Test state preservation and lack of fake sessions
  const res = await fetch(`http://127.0.0.1:${port}/api/state`);
  const data = await res.json();
  assert.equal(data.sessions.length, 1);
  assert.equal(data.sessions[0].client, 'test-agent');
  assert.equal(data.sessions[0].state, 'running');
  assert.equal(data.sessions[0].reachable, null);

  // Test CORS: foreign origin rejected
  const foreignRes = await fetch(`http://127.0.0.1:${port}/api/state`, {
    headers: { Origin: 'https://evil.attacker.com' }
  });
  assert.equal(foreignRes.headers.get('access-control-allow-origin'), null);

  // Test CORS: local origin accepted
  const localRes = await fetch(`http://127.0.0.1:${port}/api/state`, {
    headers: { Origin: 'http://localhost:3000' }
  });
  assert.equal(localRes.headers.get('access-control-allow-origin'), 'http://localhost:3000');
});

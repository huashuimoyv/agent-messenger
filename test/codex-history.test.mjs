import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { historyState, captureHistory, currentHistory, readHistory } from '../src/adapters/codex-history.mjs';
import { CodexAdapter } from '../src/adapters/codex.mjs';

const id = '11111111-2222-4333-8444-555555555555';
function fixture(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'messenger-paged-'));
  const db = new DatabaseSync(path.join(home, 'thread_history_1.sqlite'));
  db.exec(`CREATE TABLE thread_turns(thread_id TEXT,turn_id TEXT,rollout_ordinal INTEGER,status TEXT,first_user_item_id TEXT,final_agent_item_id TEXT);
    CREATE TABLE thread_items(thread_id TEXT,turn_id TEXT,item_id TEXT,rollout_ordinal INTEGER,item_type TEXT,item_json TEXT);`);
  t.after(() => { db.close(); fs.rmSync(home, { recursive: true, force: true }); });
  const turn = (name, ordinal, status, text, answer) => {
    db.prepare('INSERT INTO thread_turns VALUES (?,?,?,?,?,?)').run(id, name, ordinal, status, `${name}-user`, answer === null ? null : `${name}-final`);
    db.prepare('INSERT INTO thread_items VALUES (?,?,?,?,?,?)').run(id, name, `${name}-user`, ordinal, 'userMessage', JSON.stringify({ type: 'userMessage', content: [{ type: 'text', text }] }));
    if (answer !== null) db.prepare('INSERT INTO thread_items VALUES (?,?,?,?,?,?)').run(id, name, `${name}-final`, ordinal + 1, 'agentMessage', JSON.stringify({ type: 'agentMessage', text: answer, phase: 'final_answer' }));
  };
  return { home, db, turn };
}

test('paginated replies bind the exact envelope turn and final item', t => {
  const f = fixture(t), anchor = captureHistory(f.home, id);
  f.turn('human', 1, 'completed', 'Please inspect m-paged in the previous reply.', 'wrong human answer');
  f.turn('target', 4, 'completed', '[Agent Messenger · m-paged]\nquestion', 'correct answer');
  f.turn('other', 7, 'completed', 'later user message', 'wrong later answer');
  assert.deepEqual(readHistory(f.home, { rawId: id }, { id: 'm-paged', anchor }), { state: 'done', turn: 'target', answer: 'correct answer' });
  assert.equal(currentHistory(f.home, id, 'target').turnId, 'target');
  assert.equal(currentHistory(f.home, id).turnId, 'other');
  assert.equal(currentHistory(f.home, id, 'missing'), null);
  assert.deepEqual(readHistory(f.home, { rawId: id }, { id: 'm-paged', anchor: captureHistory(f.home, id) }), {});
});

test('paginated running and empty failed turns stay distinct from another turn answer', t => {
  const f = fixture(t);
  f.turn('target', 1, 'inProgress', '[Agent Messenger · m-empty]\nquestion', null);
  assert.equal(historyState(f.home, id), 'running');
  assert.equal(readHistory(f.home, { rawId: id }, { id: 'm-empty', anchor: {} }).state, 'started');
  f.db.prepare('UPDATE thread_turns SET status=? WHERE turn_id=?').run('interrupted', 'target');
  f.turn('other', 4, 'completed', 'later question', 'wrong answer');
  const reply = readHistory(f.home, { rawId: id }, { id: 'm-empty', anchor: {} });
  assert.equal(reply.state, 'done'); assert.equal(reply.answer, null); assert.match(reply.reason, /interrupted/);
});

test('Codex adapter reads a paginated session without a rollout file', async t => {
  const f = fixture(t);
  f.turn('target', 1, 'completed', '[Agent Messenger · m-integration]\nquestion', 'paged answer');
  const state = new DatabaseSync(path.join(f.home, 'state_5.sqlite'));
  state.exec(`CREATE TABLE threads(id TEXT,rollout_path TEXT,updated_at INTEGER,updated_at_ms INTEGER,cwd TEXT,title TEXT,history_mode TEXT,source TEXT,agent_role TEXT,agent_nickname TEXT,archived INTEGER);`);
  state.prepare('INSERT INTO threads VALUES (?,?,?,?,?,?,?,?,?,?,?)').run(id, path.join(f.home, 'absent.jsonl'), 1, 1000, f.home, 'paged session', 'paginated', 'vscode', null, null, 0);
  state.close();
  const adapter = new CodexAdapter({ codexHome: f.home, codexExecutable: process.execPath });
  const session = await adapter.get(id);
  assert.equal(session.state, 'idle'); assert.equal(session.historyMode, 'paginated');
  assert.equal((await adapter.current(session)).turnId, 'target');
  assert.equal((await adapter.read(session, { id: 'm-integration', anchor: {} })).answer, 'paged answer');
});

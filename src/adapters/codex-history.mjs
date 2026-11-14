// Current Codex paginated history. Client databases are opened read-only.
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { envelopeMessageId, textContent, messageBody } from '../io.mjs';

function history(home, missing, read) {
  const file = path.join(home, 'thread_history_1.sqlite');
  if (!fs.existsSync(file)) return missing;
  const db = new DatabaseSync(file, { readOnly: true });
  try { return read(db); } finally { db.close(); }
}

export function historyState(home, id) {
  return history(home, 'unknown', db => {
    const row = db.prepare('SELECT status FROM thread_turns WHERE thread_id=? ORDER BY rollout_ordinal DESC LIMIT 1').get(id);
    return row?.status === 'inProgress' ? 'running' : ['completed', 'failed', 'interrupted'].includes(row?.status) ? 'idle' : 'unknown';
  });
}

export function captureHistory(home, id) {
  return history(home, { historyMode: 'paginated', ordinal: -1 }, db => ({ historyMode: 'paginated',
    ordinal: db.prepare('SELECT MAX(rollout_ordinal) AS ordinal FROM thread_items WHERE thread_id=?').get(id).ordinal ?? -1 }));
}

export function currentHistory(home, id, turnId = null) {
  return history(home, null, db => {
    const turn = turnId
      ? db.prepare('SELECT turn_id,first_user_item_id FROM thread_turns WHERE thread_id=? AND turn_id=?').get(id, turnId)
      : db.prepare('SELECT turn_id,first_user_item_id FROM thread_turns WHERE thread_id=? ORDER BY rollout_ordinal DESC LIMIT 1').get(id);
    if (!turn?.first_user_item_id) return null;
    const row = db.prepare('SELECT item_json FROM thread_items WHERE thread_id=? AND turn_id=? AND item_id=?').get(id, turn.turn_id, turn.first_user_item_id);
    return row ? { text: textContent(JSON.parse(row.item_json).content), turnId: turn.turn_id } : null;
  });
}

export function readHistory(home, session, message) {
  return history(home, {}, db => {
    const users = db.prepare(`SELECT turn_id,item_json FROM thread_items
      WHERE thread_id=? AND item_type='userMessage' AND rollout_ordinal>? ORDER BY rollout_ordinal`);
    let turnId = null;
    for (const item of users.iterate(session.rawId, message.anchor?.ordinal ?? -1)) {
      if (envelopeMessageId(textContent(JSON.parse(item.item_json).content)) === message.id) { turnId = item.turn_id; break; }
    }
    if (!turnId) return {};
    const turn = db.prepare('SELECT status,final_agent_item_id FROM thread_turns WHERE thread_id=? AND turn_id=?').get(session.rawId, turnId);
    if (!turn || !['completed', 'failed', 'interrupted'].includes(turn.status)) return { state: 'started', turn: turnId };
    const final = turn.final_agent_item_id
      ? db.prepare('SELECT item_json FROM thread_items WHERE thread_id=? AND turn_id=? AND item_id=?').get(session.rawId, turnId, turn.final_agent_item_id) : null;
    return { state: 'done', turn: turnId, answer: final ? JSON.parse(final.item_json).text || null : null,
      ...(turn.status === 'completed' ? {} : { reason: `Codex turn ended with status ${turn.status}.` }) };
  });
}

export function readHistoryPrompt(home, session, message) {
  return history(home, null, db => {
    const rows = db.prepare(`SELECT item_json FROM thread_items WHERE thread_id=?
      AND item_type='userMessage' AND rollout_ordinal>? ORDER BY rollout_ordinal`);
    for (const row of rows.iterate(session.rawId, message.anchor?.ordinal ?? -1)) {
      const body = messageBody(textContent(JSON.parse(row.item_json).content), message.id);
      if (body !== null) return body;
    }
    return null;
  });
}

import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { DeliveryError } from './io.mjs';

const TERMINAL_SET = new Set(['done', 'replied', 'refused', 'expired']);
const STATE_RANK = {
  uncertain: 0,
  expired: 1,
  queued: 2,
  taken: 3,
  started: 4,
  refused: 5,
  done: 6,
  replied: 7,
};
const ALLOWED_PATCH_FIELDS = new Set(['state', 'reason', 'anchor', 'turn', 'replyId', 'toId']);

export class Journal {
  #stmts;

  constructor(folder) {
    fs.mkdirSync(folder, { recursive: true, mode: 0o700 });
    this.dbPath = path.join(folder, 'messages.sqlite');
    this.walPath = `${this.dbPath}-wal`;
    this.db = new DatabaseSync(this.dbPath);
    this.db.exec(`PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL;
      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY, requestKey TEXT NOT NULL UNIQUE, fingerprint TEXT NOT NULL,
        fromId TEXT NOT NULL, toId TEXT NOT NULL, fromClient TEXT NOT NULL, toClient TEXT NOT NULL,
        sentAt INTEGER NOT NULL, chain TEXT NOT NULL, pass INTEGER NOT NULL,
        kind TEXT NOT NULL, replyTo TEXT, replyId TEXT,
        state TEXT NOT NULL, reason TEXT, anchor TEXT NOT NULL, turn TEXT
      );
      CREATE INDEX IF NOT EXISTS received ON messages(toId,sentAt DESC);`);
    this.db.prepare('DELETE FROM messages WHERE sentAt < ?').run(Date.now() - 7 * 86_400_000);
    this.#stmts = {
      get: this.db.prepare('SELECT * FROM messages WHERE id=?'),
      request: this.db.prepare('SELECT * FROM messages WHERE requestKey=?'),
      received: this.db.prepare('SELECT * FROM messages WHERE toId=? AND state<>? ORDER BY sentAt DESC,rowid DESC'),
      settleReply: this.db.prepare('UPDATE messages SET replyId=COALESCE(replyId,?) WHERE id=?'),
    };
  }

  close() { this.db.close(); }
  decode(row) { return row ? { ...row, anchor: JSON.parse(row.anchor) } : null; }
  get(id) { return this.decode(this.#stmts.get.get(id)); }
  request(key) { return this.decode(this.#stmts.request.get(key)); }
  received(to) { return this.#stmts.received.all(to, 'refused').map(r => this.decode(r)); }
  watchTargets() { return [this.walPath, this.dbPath]; }

  // Commit the intent before any external bytes can leave. A second MCP process
  // sees the reservation and returns it instead of submitting another prompt.
  reserve(record) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const old = this.request(record.requestKey);
      if (old) {
        if (old.fingerprint !== record.fingerprint) {
          throw new DeliveryError('request_id was already used with different content. Choose a new request_id.');
        }
        this.db.exec('COMMIT');
        return { record: old, created: false };
      }
      const fields = Object.keys(record);
      this.db.prepare(`INSERT INTO messages (${fields.join(',')}) VALUES (${fields.map(() => '?').join(',')})`)
        .run(...fields.map(k => k === 'anchor' ? JSON.stringify(record[k]) : record[k]));
      this.db.exec('COMMIT');
      return { record: this.get(record.id), created: true };
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  update(id, patch) {
    const fields = Object.keys(patch);
    if (!fields.length) return this.get(id);
    for (const key of fields) {
      if (!ALLOWED_PATCH_FIELDS.has(key)) throw new Error(`Invalid journal field: ${key}`);
    }
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const old = this.get(id);
      const next = { ...patch };
      if (old && next.state) {
        if (TERMINAL_SET.has(old.state)) {
          if (!TERMINAL_SET.has(next.state) || (old.state === 'replied' && next.state !== 'replied') || (old.state === 'done' && ['expired', 'uncertain'].includes(next.state))) {
            delete next.state;
            delete next.reason;
          }
        } else if (next.state in STATE_RANK && old.state in STATE_RANK && STATE_RANK[next.state] < STATE_RANK[old.state]) {
          delete next.state;
          delete next.reason;
        }
      }
      const keys = Object.keys(next);
      if (keys.length) {
        this.db.prepare(`UPDATE messages SET ${keys.map(k => `${k}=?`).join(',')} WHERE id=?`)
          .run(...keys.map(k => k === 'anchor' ? JSON.stringify(next[k]) : next[k]), id);
      }
      this.db.exec('COMMIT');
      return this.get(id);
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  settleReply(parent, reply) {
    this.#stmts.settleReply.run(reply, parent);
  }
}

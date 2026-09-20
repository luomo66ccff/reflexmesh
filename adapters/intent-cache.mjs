import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { openSync, closeSync, lstatSync } from 'node:fs';
import { ContractError, canonical, snapshot } from '../dist/index.js';
import { intentDigest, validateIntentScope, selectExplicitSummary, inspectTaskIntent, MAX_INTENT_TTL_MS } from './task-evidence.mjs';

// Separate opt-in cache, NOT the durable execution ledger or long-term memory.
// DELETE journal avoids a new WAL-mode transition. BEGIN IMMEDIATE serializes initialization/writes.
const APP_ID = 1380796739; // RMIC, reserved to this cache schema.
export class IntentCache {
  #db; #clock; #tenant; #scope; #ttl; #capacity;
  constructor(path, { tenantId, scope, ttlMs = MAX_INTENT_TTL_MS, maxSessions = 128, clock = Date.now } = {}) {
    if (typeof path !== 'string' || !path || ![tenantId, scope].every(x => typeof x === 'string' && x.length > 0 && x.length <= 64)
      || !Number.isSafeInteger(ttlMs) || ttlMs < 1 || ttlMs > MAX_INTENT_TTL_MS
      || !Number.isSafeInteger(maxSessions) || maxSessions < 1 || maxSessions > 1024 || typeof clock !== 'function') throw new ContractError('Invalid intent cache configuration');
    if (path !== ':memory:') {
      try { closeSync(openSync(path, 'wx', 0o600)); } catch (e) { if (e.code !== 'EEXIST') throw e; }
      const stat = lstatSync(path);
      if (!stat.isFile() || stat.isSymbolicLink()) throw new ContractError('Intent cache must be a regular local file');
    }
    this.#clock = clock; this.#tenant = tenantId; this.#scope = scope; this.#ttl = ttlMs; this.#capacity = maxSessions;
    this.#db = new DatabaseSync(path);
    try {
      this.#db.exec('PRAGMA busy_timeout=2000;');
      this.#tx(() => {
        const app = this.#db.prepare('PRAGMA application_id').get().application_id;
        const version = this.#db.prepare('PRAGMA user_version').get().user_version;
        const tables = this.#db.prepare("SELECT count(*) AS n FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%'").get().n;
        if (!((app === APP_ID && version === 1) || (app === 0 && version === 0 && tables === 0))) throw new ContractError('Not a compatible intent cache; never use the execution database');
        this.#db.exec(`CREATE TABLE IF NOT EXISTS intents (
          key TEXT PRIMARY KEY, namespace TEXT NOT NULL, session_digest TEXT NOT NULL,
          expires_at INTEGER NOT NULL, body TEXT NOT NULL
        ) STRICT;
        CREATE INDEX IF NOT EXISTS intent_expiry ON intents(expires_at);
        PRAGMA application_id=${APP_ID}; PRAGMA user_version=1;`);
      });
      this.#db.exec('PRAGMA secure_delete=ON; PRAGMA synchronous=FULL;');
    } catch (e) { this.#db.close(); throw e; }
  }
  #now() { const t = this.#clock(); if (!Number.isSafeInteger(t) || t < 0) throw new ContractError('Invalid intent clock'); return t; }
  #tx(fn) { this.#db.exec('BEGIN IMMEDIATE'); try { const value = fn(); this.#db.exec('COMMIT'); return value; } catch (e) { this.#db.exec('ROLLBACK'); throw e; } }
  #namespace() { return intentDigest([this.#tenant, this.#scope]); }
  #key(scope) { return intentDigest([this.#namespace(), validateIntentScope(scope)]); }
  #session(scope) { return intentDigest([scope.harness, scope.sessionId]); }
  capture(scope, prompt) {
    const identity = validateIntentScope(scope), key = this.#key(identity), now = this.#now();
    if (identity.harness !== 'claude-code') throw new ContractError('Explicit prompt capture is Claude-only; use host-declared evidence for other harnesses');
    const selected = selectExplicitSummary(prompt);
    const envelope = selected.status === 'ready' ? { schemaVersion: 1, id: randomUUID(), scope: identity,
      source: 'claude-explicit-summary', summary: selected.summary, issuedAt: now, expiresAt: now + this.#ttl } : null;
    if (envelope) inspectTaskIntent(envelope, identity, now);
    return this.#tx(() => {
      this.#db.prepare('DELETE FROM intents WHERE expires_at<=?').run(now);
      // A new unselected/invalid prompt MUST invalidate previous intent; do not reuse yesterday's goal.
      this.#db.prepare('DELETE FROM intents WHERE key=?').run(key);
      if (!envelope) return { status: selected.status, retained: false };
      if (this.#db.prepare('SELECT count(*) AS n FROM intents').get().n >= this.#capacity) return { status: 'capacity', retained: false };
      this.#db.prepare('INSERT INTO intents VALUES(?,?,?,?,?)').run(key, this.#namespace(), this.#session(identity), envelope.expiresAt, canonical(envelope));
      return { status: 'ready', retained: true, intentId: envelope.id, expiresAt: envelope.expiresAt };
    });
  }
  current(scope) {
    const identity = validateIntentScope(scope), now = this.#now();
    return this.#tx(() => {
      this.#db.prepare('DELETE FROM intents WHERE expires_at<=?').run(now);
      const row = this.#db.prepare('SELECT body FROM intents WHERE key=?').get(this.#key(identity));
      if (!row) return null;
      const envelope = JSON.parse(row.body);
      const checked = inspectTaskIntent(envelope, identity, now);
      if (checked.receipt.status !== 'ready') { this.#db.prepare('DELETE FROM intents WHERE key=?').run(this.#key(identity)); return null; }
      return snapshot(envelope);
    });
  }
  clear(scope) { const key = this.#key(scope); return this.#tx(() => this.#db.prepare('DELETE FROM intents WHERE key=?').run(key).changes); }
  clearNamespace() { return this.#tx(() => this.#db.prepare('DELETE FROM intents WHERE namespace=?').run(this.#namespace()).changes); }
  clearSession(scope) {
    const identity = validateIntentScope(scope);
    return this.#tx(() => this.#db.prepare('DELETE FROM intents WHERE namespace=? AND session_digest=?').run(this.#namespace(), this.#session(identity)).changes);
  }
  prune() { return this.#tx(() => this.#db.prepare('DELETE FROM intents WHERE expires_at<=?').run(this.#now()).changes); }
  close() { this.#db.close(); }
}

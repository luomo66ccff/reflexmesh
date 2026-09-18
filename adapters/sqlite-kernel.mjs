import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { closeSync, openSync } from 'node:fs';
import { canonical, snapshot, validatePack, ContractError } from '../dist/index.js';

export const digest = value => createHash('sha256').update(canonical(value)).digest('hex');
const requireValue = (ok, message) => { if (!ok) throw new ContractError(message); };
const text = value => typeof value === 'string' && value.length > 0 && value.length <= 1024;

/** Single-node, process-safe admission. Never put this database on a network filesystem. */
export class SqliteKernel {
  #db;
  #clock;
  constructor(path, { clock = Date.now, busyTimeoutMs = 2000 } = {}) {
    requireValue(text(path) && Number.isSafeInteger(busyTimeoutMs) && busyTimeoutMs >= 0 && busyTimeoutMs <= 10000, 'Invalid SQLite options');
    // Create with restrictive permissions; never tighten/replace an existing file silently.
    if (path !== ':memory:') {
      try { closeSync(openSync(path, 'wx', 0o600)); } catch (e) { if (e.code !== 'EEXIST') throw e; }
    }
    this.#clock = clock;
    this.#db = new DatabaseSync(path);
    try {
      this.#db.exec(`PRAGMA busy_timeout=${busyTimeoutMs}; PRAGMA foreign_keys=ON;`);
      const version = this.#db.prepare('PRAGMA user_version').get().user_version;
      requireValue(version === 0 || version === 1, 'Unsupported kernel schema');
      this.#db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;');
      this.#transaction(() => {
        this.#db.exec(`
          CREATE TABLE IF NOT EXISTS packs (
            id TEXT NOT NULL, version TEXT NOT NULL, digest TEXT NOT NULL,
            body TEXT NOT NULL, PRIMARY KEY(id, version)
          ) STRICT;
          CREATE TABLE IF NOT EXISTS runs (
            key TEXT PRIMARY KEY, request_digest TEXT NOT NULL,
            state TEXT NOT NULL CHECK(state IN ('admitted','executing','completed','unknown')),
            epoch INTEGER NOT NULL, owner TEXT NOT NULL, lease_until INTEGER NOT NULL,
            evidence TEXT NOT NULL, result TEXT
          ) STRICT;
          CREATE TABLE IF NOT EXISTS audit (
            seq INTEGER PRIMARY KEY, run_key TEXT NOT NULL REFERENCES runs(key),
            kind TEXT NOT NULL, details TEXT NOT NULL, at INTEGER NOT NULL
          ) STRICT;
          CREATE TABLE IF NOT EXISTS observations (
            run_key TEXT NOT NULL REFERENCES runs(key), id TEXT NOT NULL,
            body TEXT NOT NULL, PRIMARY KEY(run_key,id)
          ) STRICT;
          CREATE TABLE IF NOT EXISTS labels (
            run_key TEXT NOT NULL REFERENCES runs(key), id TEXT NOT NULL,
            body TEXT NOT NULL, PRIMARY KEY(run_key,id)
          ) STRICT;
          PRAGMA user_version=1;
        `);
      });
    } catch (e) { this.#db.close(); throw e; }
  }
  #now() {
    const now = this.#clock();
    requireValue(Number.isSafeInteger(now) && now >= 0, 'Invalid clock');
    return now;
  }
  #transaction(fn) {
    this.#db.exec('BEGIN IMMEDIATE');
    try { const value = fn(); this.#db.exec('COMMIT'); return value; }
    catch (e) { this.#db.exec('ROLLBACK'); throw e; }
  }
  #row(key) { return this.#db.prepare('SELECT * FROM runs WHERE key=?').get(key); }
  #audit(key, kind, details) {
    this.#db.prepare('INSERT INTO audit(run_key,kind,details,at) VALUES(?,?,?,?)').run(key, kind, canonical(details), this.#now());
  }
  #owned(handle) {
    const row = this.#row(handle.key);
    requireValue(row && row.owner === handle.owner && row.epoch === handle.epoch && ['admitted','executing'].includes(row.state) && row.lease_until > this.#now(), 'Lease lost or execution fenced');
    return row;
  }
  registerPack(pack) {
    validatePack(pack);
    const body = canonical(pack), hash = digest(pack);
    return this.#transaction(() => {
      const prior = this.#db.prepare('SELECT digest FROM packs WHERE id=? AND version=?').get(pack.id, pack.version);
      requireValue(!prior || prior.digest === hash, 'Pack version is immutable; bump its version');
      this.#db.prepare('INSERT OR IGNORE INTO packs VALUES(?,?,?,?)').run(pack.id, pack.version, hash, body);
      return hash;
    });
  }
  claim({ key, requestDigest, owner, leaseMs, evidence }) {
    requireValue([key, requestDigest, owner].every(text) && Number.isSafeInteger(leaseMs) && leaseMs > 0 && leaseMs <= 3600000, 'Invalid admission');
    const encodedEvidence = canonical(evidence);
    return this.#transaction(() => {
      const row = this.#row(key), now = this.#now();
      if (row) {
        requireValue(row.request_digest === requestDigest, 'Idempotency conflict');
        if (row.state === 'completed') return { kind: 'replay', result: snapshot(JSON.parse(row.result)) };
        if (row.state === 'unknown') return { kind: 'unknown' };
        if (row.lease_until > now) return { kind: 'busy' };
        // Executing may already have affected the outside world. Never steal/retry it.
        if (row.state === 'executing') {
          this.#db.prepare("UPDATE runs SET state='unknown',epoch=epoch+1 WHERE key=?").run(key);
          this.#audit(key, 'execution.unknown', { reason: 'executing_lease_expired' });
          return { kind: 'unknown' };
        }
        this.#db.prepare('UPDATE runs SET epoch=epoch+1,owner=?,lease_until=? WHERE key=?').run(owner, now + leaseMs, key);
      } else {
        this.#db.prepare("INSERT INTO runs VALUES(?,?,'admitted',1,?,?,?,NULL)").run(key, requestDigest, owner, now + leaseMs, encodedEvidence);
      }
      const epoch = this.#row(key).epoch;
      this.#audit(key, 'event.admitted', { epoch, reclaimed: !!row });
      return { kind: 'claimed', handle: Object.freeze({ key, owner, epoch }) };
    });
  }
  append(handle, record) {
    // This sink is called only by our trusted runtime; no raw arguments/results are logged.
    const details = snapshot(record.details);
    this.#transaction(() => {
      const row = this.#owned(handle);
      if (record.kind === 'action.started') {
        requireValue(row.state === 'admitted', 'Action already started');
        this.#db.prepare("UPDATE runs SET state='executing' WHERE key=?").run(handle.key);
      }
      this.#audit(handle.key, record.kind, details);
    });
  }
  complete(handle, result) {
    // Deliberately not a tool-output cache. Returning a result once does not authorize durable retention.
    const { output: _output, ...metadata } = result;
    const body = canonical(metadata);
    this.#transaction(() => {
      this.#owned(handle);
      const state = result.status === 'recovery_required' ? 'unknown' : 'completed';
      this.#db.prepare('UPDATE runs SET state=?,result=? WHERE key=?').run(state, body, handle.key);
      this.#audit(handle.key, 'run.settled', { state });
    });
  }
  abandon(handle) {
    this.#transaction(() => {
      const row = this.#row(handle.key);
      if (!row || row.owner !== handle.owner || row.epoch !== handle.epoch || !['admitted','executing'].includes(row.state)) return;
      this.#db.prepare("UPDATE runs SET state='unknown',epoch=epoch+1 WHERE key=?").run(handle.key);
      this.#audit(handle.key, 'execution.unknown', { reason: 'runtime_failure' });
    });
  }
  observe(key, observation) {
    requireValue(text(observation.id) && ['succeeded','failed','unknown'].includes(observation.status) && ['harness-reported','model-reported','test-oracle'].includes(observation.provenance) && /^[a-f0-9]{64}$/.test(observation.evidenceDigest), 'Invalid outcome evidence');
    // Whitelist fields. Model/harness observations are explicitly NOT ground-truth labels.
    const body = canonical({ id: observation.id, status: observation.status, provenance: observation.provenance, evidenceDigest: observation.evidenceDigest });
    this.#transaction(() => {
      requireValue(!!this.#row(key), 'Orphan outcome');
      const old = this.#db.prepare('SELECT body FROM observations WHERE run_key=? AND id=?').get(key, observation.id);
      requireValue(!old || old.body === body, 'Outcome conflict');
      this.#db.prepare('INSERT OR IGNORE INTO observations VALUES(?,?,?)').run(key, observation.id, body);
    });
  }
  addLabel(key, label) {
    requireValue(text(label.id) && text(label.questionId) && text(label.sourceRef) && ['human','test-oracle'].includes(label.provenance), 'Independent label provenance required');
    const body = canonical({ id: label.id, questionId: label.questionId, value: label.value, provenance: label.provenance, sourceRef: label.sourceRef });
    this.#transaction(() => {
      const row = this.#row(key);
      requireValue(row?.state === 'completed' && JSON.parse(row.result).provider?.answers?.[label.questionId], 'No completed prediction for this label');
      const old = this.#db.prepare('SELECT body FROM labels WHERE run_key=? AND id=?').get(key, label.id);
      requireValue(!old || old.body === body, 'Label conflict');
      this.#db.prepare('INSERT OR IGNORE INTO labels VALUES(?,?,?)').run(key, label.id, body);
    });
  }
  inspect(key) {
    const row = this.#row(key);
    if (!row) return undefined;
    return snapshot({ key, state: row.state, epoch: row.epoch,
      evidence: JSON.parse(row.evidence), result: row.result ? JSON.parse(row.result) : null,
      audit: this.#db.prepare('SELECT kind,details,at FROM audit WHERE run_key=? ORDER BY seq').all(key).map(r => ({ ...r, details: JSON.parse(r.details) })),
      observations: this.#db.prepare('SELECT body FROM observations WHERE run_key=? ORDER BY id').all(key).map(r => JSON.parse(r.body)),
      labels: this.#db.prepare('SELECT body FROM labels WHERE run_key=? ORDER BY id').all(key).map(r => JSON.parse(r.body)),
    });
  }
  close() { this.#db.close(); }
}

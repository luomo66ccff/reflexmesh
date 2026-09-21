import { DatabaseSync } from 'node:sqlite';
import { configureJournal } from './sqlite-startup.mjs';
import { createHash } from 'node:crypto';
import { closeSync, openSync } from 'node:fs';
import { canonical, snapshot, validatePack, ContractError } from '../dist/index.js';
import { validateRecoveryReview, validateLabelEnvelope, validateLabelValue } from './recovery-contract.mjs';
import { evidenceColumns, evidenceView } from './evidence-view.mjs';

export const digest = value => createHash('sha256').update(canonical(value)).digest('hex');
const requireValue = (ok, message) => { if (!ok) throw new ContractError(message); };
const text = value => typeof value === 'string' && value.length > 0 && value.length <= 1024;

/** Single-node, process-safe admission. Never put this database on a network filesystem. */
export class SqliteKernel {
  #db;
  #clock;
  #readOnly;
  #schemaVersion;
  constructor(path, { clock = Date.now, busyTimeoutMs = 2000, readOnly = false } = {}) {
    requireValue(text(path) && typeof readOnly === 'boolean' && typeof clock === 'function' && Number.isSafeInteger(busyTimeoutMs) && busyTimeoutMs >= 0 && busyTimeoutMs <= 10000, 'Invalid SQLite options');
    // Create with restrictive permissions; never tighten/replace an existing file silently.
    if (!readOnly && path !== ':memory:') {
      try { closeSync(openSync(path, 'wx', 0o600)); } catch (e) { if (e.code !== 'EEXIST') throw e; }
    }
    this.#clock = clock;
    this.#readOnly = readOnly;
    this.#db = new DatabaseSync(path, { readOnly });
    try {
      this.#db.exec(`PRAGMA busy_timeout=${busyTimeoutMs}; PRAGMA foreign_keys=ON;`);
      const version = this.#db.prepare('PRAGMA user_version').get().user_version;
      requireValue([0, 1, 2].includes(version) && (!readOnly || version > 0), 'Unsupported kernel schema');
      this.#schemaVersion = version;
      if (readOnly) return; // No DDL, migration, mode changes or application writes from an inspector.
      configureJournal(this.#db, { busyTimeoutMs, inMemory: path === ':memory:' });
      this.#transaction(() => {
        // Recheck under the write lock: a concurrent opener may have migrated since the first read.
        const lockedVersion = this.#db.prepare('PRAGMA user_version').get().user_version;
        requireValue([0, 1, 2].includes(lockedVersion), 'Unsupported kernel schema');
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
          CREATE TABLE IF NOT EXISTS recovery_reviews (
            run_key TEXT NOT NULL REFERENCES runs(key), id TEXT NOT NULL,
            body TEXT NOT NULL, digest TEXT NOT NULL, applied_epoch INTEGER NOT NULL,
            at INTEGER NOT NULL, PRIMARY KEY(run_key,id), UNIQUE(run_key,applied_epoch)
          ) STRICT;
          CREATE INDEX IF NOT EXISTS runs_recovery_scan ON runs(state,key);
          PRAGMA user_version=2;
        `);
      });
      this.#schemaVersion = 2;
    } catch (e) { this.#db.close(); throw e; }
  }
  #now() {
    const now = this.#clock();
    requireValue(Number.isSafeInteger(now) && now >= 0, 'Invalid clock');
    return now;
  }
  #transaction(fn) {
    requireValue(!this.#readOnly, 'Read-only kernel');
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
  addLabel(key, input) {
    const label = validateLabelEnvelope(input), body = canonical(label);
    this.#transaction(() => {
      const row = this.#row(key);
      requireValue(row?.state === 'completed', 'No completed prediction for this label');
      const answers = JSON.parse(row.result)?.provider?.answers;
      // An inherited "constructor"/"toString" is not a prediction.
      requireValue(answers && Object.hasOwn(answers, label.questionId), 'No completed prediction for this label');
      const ref = JSON.parse(row.evidence).pack;
      requireValue(ref && text(ref.id) && text(ref.version), 'Missing label contract');
      const stored = this.#db.prepare('SELECT body,digest FROM packs WHERE id=? AND version=?').get(ref.id, ref.version);
      requireValue(stored && stored.digest === ref.digest, 'Label contract mismatch');
      const pack = JSON.parse(stored.body);
      validatePack(pack);
      requireValue(digest(pack) === ref.digest && Object.hasOwn(pack.questions, label.questionId), 'Unknown label question');
      validateLabelValue(pack.questions[label.questionId], label.value);
      const old = this.#db.prepare('SELECT body FROM labels WHERE run_key=? AND id=?').get(key, label.id);
      requireValue(!old || old.body === body, 'Label conflict');
      this.#db.prepare('INSERT OR IGNORE INTO labels VALUES(?,?,?)').run(key, label.id, body);
    });
  }
  #reviewById(key, id) {
    if (this.#schemaVersion < 2) return undefined;
    return this.#db.prepare('SELECT * FROM recovery_reviews WHERE run_key=? AND id=?').get(key, id);
  }
  #latestReview(key) {
    if (this.#schemaVersion < 2) return null;
    const row = this.#db.prepare('SELECT body,digest,applied_epoch,at FROM recovery_reviews WHERE run_key=? ORDER BY applied_epoch DESC LIMIT 1').get(key);
    return row ? { review: JSON.parse(row.body), digest: row.digest, appliedEpoch: row.applied_epoch, recordedAt: row.at } : null;
  }
  #checkReview(review) {
    const row = this.#row(review.runKey);
    requireValue(!!row, 'Unknown recovery run');
    requireValue(row.request_digest === review.inputDigest, 'Recovery input digest conflict');
    requireValue(row.epoch === review.expectedEpoch, 'Recovery epoch conflict; inspect again');
    requireValue(['unknown', 'executing'].includes(row.state), 'Run is not awaiting recovery');
    requireValue(row.lease_until <= this.#now(), 'Execution lease is still live');
    return row;
  }
  previewRecovery(input) {
    const review = validateRecoveryReview(input), body = canonical(review);
    const prior = this.#reviewById(review.runKey, review.id);
    if (prior) requireValue(prior.body === body, 'Recovery review ID conflict');
    else this.#checkReview(review);
    return snapshot({ mode: 'preview', wouldRecord: !prior, runKey: review.runKey, reviewId: review.id,
      expectedEpoch: review.expectedEpoch, appliedEpoch: prior?.applied_epoch ?? review.expectedEpoch + 1,
      resolution: review.resolution, state: 'unknown', executionAllowed: false });
  }
  reviewRecovery(input) {
    const review = validateRecoveryReview(input), body = canonical(review), hash = digest(review);
    return this.#transaction(() => {
      const prior = this.#reviewById(review.runKey, review.id);
      if (prior) {
        requireValue(prior.body === body, 'Recovery review ID conflict');
        return snapshot({ recorded: true, replayed: true, runKey: review.runKey, reviewId: review.id,
          appliedEpoch: prior.applied_epoch, state: 'unknown', executionAllowed: false });
      }
      this.#checkReview(review);
      const at = this.#now();
      const updated = this.#db.prepare("UPDATE runs SET state='unknown',epoch=epoch+1 WHERE key=? AND epoch=? AND request_digest=? AND state IN ('unknown','executing') AND lease_until<=?")
        .run(review.runKey, review.expectedEpoch, review.inputDigest, at);
      requireValue(updated.changes === 1, 'Recovery compare-and-set conflict');
      const epoch = review.expectedEpoch + 1;
      this.#db.prepare('INSERT INTO recovery_reviews VALUES(?,?,?,?,?,?)').run(review.runKey, review.id, body, hash, epoch, at);
      this.#audit(review.runKey, 'recovery.reviewed', { reviewId: review.id, reviewDigest: hash, resolution: review.resolution, epoch });
      // The administrative conclusion never turns an unknown execution into a replayable success.
      return snapshot({ recorded: true, replayed: false, runKey: review.runKey, reviewId: review.id,
        appliedEpoch: epoch, state: 'unknown', executionAllowed: false });
    });
  }
  recoverySnapshot(key) {
    requireValue(text(key), 'Invalid recovery key');
    const row = this.#row(key);
    if (!row) return undefined;
    return snapshot({ key, state: row.state, epoch: row.epoch, inputDigest: row.request_digest,
      leaseUntil: row.lease_until, leaseExpired: row.lease_until <= this.#now(),
      // Bounded operational view, no raw inputs/outputs or unbounded audit history.
      latestReview: this.#latestReview(key), executionAllowed: false });
  }
  listRecoveries({ limit = 50, after = '', includeReviewed = false } = {}) {
    requireValue(Number.isSafeInteger(limit) && limit >= 1 && limit <= 100 && typeof after === 'string'
      && after.length <= 1024 && typeof includeReviewed === 'boolean', 'Invalid recovery page');
    // Keyset pagination, never delete/evict execution tombstones to shrink this queue.
    const reviewJoin = this.#schemaVersion >= 2
      ? 'LEFT JOIN recovery_reviews v ON v.run_key=r.key AND v.applied_epoch=(SELECT MAX(applied_epoch) FROM recovery_reviews WHERE run_key=r.key)'
      : '';
    const filter = !includeReviewed && this.#schemaVersion >= 2
      ? "AND (v.id IS NULL OR json_extract(v.body,'$.resolution')='unresolved')" : '';
    const rows = this.#db.prepare(`SELECT r.key FROM runs r ${reviewJoin}
      WHERE (r.state='unknown' OR (r.state='executing' AND r.lease_until<=?))
      AND r.key>? ${filter} ORDER BY r.key LIMIT ?`).all(this.#now(), after, limit + 1);
    const page = rows.slice(0, limit);
    return snapshot({ items: page.map(r => this.recoverySnapshot(r.key)),
      nextCursor: rows.length > limit ? page.at(-1).key : null });
  }
  #readEvidence(fn) {
    // One read transaction keeps pagination, decisions and outcome counts coherent.
    // This is also allowed on read-only/schema-1 connections: no migration or DDL.
    this.#db.exec('BEGIN');
    try { const result = fn(this.#now()); this.#db.exec('COMMIT'); return snapshot(result); }
    catch (error) { this.#db.exec('ROLLBACK'); throw error; }
  }
  evidenceSnapshot(key) {
    requireValue(text(key), 'Invalid evidence key');
    return this.#readEvidence(now => {
      const row = this.#db.prepare(`SELECT ${evidenceColumns(this.#schemaVersion)} FROM runs r WHERE r.key=?`).get(key);
      if (row) requireValue(text(row.key), 'Invalid stored evidence key');
      return row ? evidenceView(row, now) : null;
    });
  }
  listEvidence({ limit = 20, after = '', state = null } = {}) {
    requireValue(Number.isSafeInteger(limit) && limit >= 1 && limit <= 100 && typeof after === 'string' && after.length <= 1024
      && (state === null || ['admitted','executing','completed','unknown'].includes(state)), 'Invalid evidence page');
    return this.#readEvidence(now => {
      const rows = this.#db.prepare(`SELECT ${evidenceColumns(this.#schemaVersion)} FROM runs r
        WHERE r.key>? AND (? IS NULL OR r.state=?) ORDER BY r.key LIMIT ?`).all(after, state, state, limit + 1);
      const page = rows.slice(0, limit);
      for (const row of page) requireValue(text(row.key), 'Invalid stored evidence key');
      return { items: page.map(row => evidenceView(row, now)), nextCursor: rows.length > limit ? page.at(-1).key : null };
    });
  }
  inspect(key) {
    const row = this.#row(key);
    if (!row) return undefined;
    return snapshot({ key, state: row.state, epoch: row.epoch, latestRecoveryReview: this.#latestReview(key),
      evidence: JSON.parse(row.evidence), result: row.result ? JSON.parse(row.result) : null,
      audit: this.#db.prepare('SELECT kind,details,at FROM audit WHERE run_key=? ORDER BY seq').all(key).map(r => ({ ...r, details: JSON.parse(r.details) })),
      observations: this.#db.prepare('SELECT body FROM observations WHERE run_key=? ORDER BY id').all(key).map(r => JSON.parse(r.body)),
      labels: this.#db.prepare('SELECT body FROM labels WHERE run_key=? ORDER BY id').all(key).map(r => JSON.parse(r.body)),
    });
  }
  close() { this.#db.close(); }
}

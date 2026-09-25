import { DatabaseSync } from 'node:sqlite';
import { configureJournal } from './sqlite-startup.mjs';
import { createHash, randomUUID } from 'node:crypto';
import { closeSync, openSync } from 'node:fs';
import { canonical, snapshot, validatePack, validateResult, evaluatePolicy, ContractError } from '../dist/index.js';
import { validateRecoveryReview, validateLabelEnvelope, validateLabelValue } from './recovery-contract.mjs';
import { evidenceAttentionView, evidenceColumns, evidenceView } from './evidence-view.mjs';
import { storageTables, storageView } from './storage-view.mjs';
import { assertSqliteWalRuntime } from './sqlite-runtime.mjs';
import { inspectAuditArchiveMetadata } from './audit-archive-schema.mjs';

export const digest = value => createHash('sha256').update(canonical(value)).digest('hex');
const requireValue = (ok, message) => { if (!ok) throw new ContractError(message); };
const text = value => typeof value === 'string' && value.length > 0 && value.length <= 1024;
const hash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const MAX_SQLITE_ROWID = 9223372036854775807n;
const PAIR_REASONS = Object.freeze(['duplicate_pre', 'legacy_unpaired', 'before_failed', 'unpaired_post',
  'early_post', 'token_mismatch', 'descriptor_mismatch', 'decision_mismatch', 'run_missing',
  'action_mismatch', 'deployment_mismatch', 'request_mismatch', 'outcome_conflict', 'invalid_state']);
const pairFields = ['key', 'callDigest', 'actionDigest', 'deploymentDigest'];
function pairingDescriptor(value, receipt = false) {
  requireValue(value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).sort().join(',') === [...pairFields, ...(receipt ? ['token'] : [])].sort().join(',')
    && text(value.key) && [value.callDigest, value.actionDigest, value.deploymentDigest].every(hash)
    && (!receipt || typeof value.token === 'string' && /^[a-f0-9-]{36}$/.test(value.token)), 'Invalid Claude pairing descriptor');
  return value;
}
function outcomeBody(observation) {
  requireValue(observation && text(observation.id) && ['succeeded','failed','unknown'].includes(observation.status)
    && ['harness-reported','model-reported','test-oracle'].includes(observation.provenance)
    && hash(observation.evidenceDigest), 'Invalid outcome evidence');
  return canonical({ id: observation.id, status: observation.status, provenance: observation.provenance,
    evidenceDigest: observation.evidenceDigest });
}

/** Single-node, process-safe admission. Never put this database on a network filesystem. */
export class SqliteKernel {
  #db;
  #clock;
  #readOnly;
  #schemaVersion;
  constructor(path, { clock = Date.now, busyTimeoutMs = 2000, readOnly = false } = {}) {
    requireValue(text(path) && typeof readOnly === 'boolean' && typeof clock === 'function' && Number.isSafeInteger(busyTimeoutMs) && busyTimeoutMs >= 0 && busyTimeoutMs <= 10000, 'Invalid SQLite options');
    if (!readOnly && path !== ':memory:') assertSqliteWalRuntime();
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
      requireValue([0, 1, 2, 3, 4].includes(version) && (!readOnly || version > 0), 'Unsupported kernel schema');
      this.#schemaVersion = version;
      if (readOnly) return; // No DDL, migration, mode changes or application writes from an inspector.
      configureJournal(this.#db, { busyTimeoutMs, inMemory: path === ':memory:' });
      this.#transaction(() => {
        // Recheck under the write lock: a concurrent opener may have migrated since the first read.
        const lockedVersion = this.#schemaVersion;
        requireValue([0, 1, 2, 3, 4].includes(lockedVersion), 'Unsupported kernel schema');
        if (lockedVersion === 4) return; // Archival is explicit maintenance; ordinary open never downgrades it.
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
          CREATE TABLE IF NOT EXISTS claude_hook_pairs (
            key TEXT PRIMARY KEY, token TEXT NOT NULL, call_digest TEXT NOT NULL,
            action_digest TEXT NOT NULL, deployment_digest TEXT NOT NULL,
            request_digest TEXT,
            state TEXT NOT NULL CHECK(state IN ('pending','ready','blocked')),
            reason_code TEXT CHECK(reason_code IN ('duplicate_pre','legacy_unpaired','before_failed',
              'unpaired_post','early_post','token_mismatch','descriptor_mismatch','decision_mismatch',
              'run_missing','action_mismatch','deployment_mismatch','request_mismatch','outcome_conflict',
              'invalid_state')),
            CHECK((state='blocked')=(reason_code IS NOT NULL))
          ) STRICT;
          CREATE INDEX IF NOT EXISTS runs_recovery_scan ON runs(state,key);
          PRAGMA user_version=3;
        `);
        this.#schemaVersion = 3;
      });
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
    try {
      const version = this.#db.prepare('PRAGMA user_version').get().user_version;
      requireValue([0, 1, 2, 3, 4].includes(version), 'Unsupported kernel schema');
      this.#schemaVersion = version;
      const value = fn(); this.#db.exec('COMMIT'); return value;
    }
    catch (e) { this.#db.exec('ROLLBACK'); throw e; }
  }
  #row(key) { return this.#db.prepare('SELECT * FROM runs WHERE key=?').get(key); }
  #pair(key) { return this.#db.prepare('SELECT * FROM claude_hook_pairs WHERE key=?').get(key); }
  #insertPair(descriptor, token, state, reason = null) {
    this.#db.prepare('INSERT INTO claude_hook_pairs VALUES(?,?,?,?,?,?,?,?)')
      .run(descriptor.key, token, descriptor.callDigest, descriptor.actionDigest,
        descriptor.deploymentDigest, null, state, reason);
  }
  #blockPair(descriptor, reason, existing = this.#pair(descriptor.key)) {
    requireValue(PAIR_REASONS.includes(reason), 'Invalid Claude pairing reason');
    if (!existing) this.#insertPair(descriptor, randomUUID(), 'blocked', reason);
    else if (existing.state !== 'blocked') this.#db.prepare("UPDATE claude_hook_pairs SET state='blocked',reason_code=? WHERE key=?")
      .run(reason, descriptor.key);
    return existing?.state === 'blocked' ? existing.reason_code ?? reason : reason;
  }
  #pairRunMismatch(descriptor, run) {
    if (!run) return 'run_missing';
    let evidence;
    try { evidence = JSON.parse(run.evidence); } catch { return 'deployment_mismatch'; }
    if (evidence?.actionDigest !== descriptor.actionDigest) return 'action_mismatch';
    try {
      if (digest({ packDigest: evidence?.pack?.digest, binding: evidence?.binding, mode: evidence?.mode })
        !== descriptor.deploymentDigest) return 'deployment_mismatch';
    } catch { return 'deployment_mismatch'; }
    return null;
  }
  #pairDescriptorMismatch(descriptor, pair) {
    return pair.call_digest !== descriptor.callDigest || pair.action_digest !== descriptor.actionDigest
      || pair.deployment_digest !== descriptor.deploymentDigest;
  }
  beginClaudeHookPairing(descriptor) {
    pairingDescriptor(descriptor);
    const result = this.#transaction(() => {
      const existing = this.#pair(descriptor.key);
      if (existing) {
        // A second PreToolUse is ambiguous even if its digest is identical.
        return { reason: this.#blockPair(descriptor, 'duplicate_pre', existing) };
      }
      if (this.#row(descriptor.key)) {
        this.#insertPair(descriptor, randomUUID(), 'blocked', 'legacy_unpaired');
        return { reason: 'legacy_unpaired' };
      }
      const token = randomUUID();
      this.#insertPair(descriptor, token, 'pending');
      return { receipt: Object.freeze({ key: descriptor.key, callDigest: descriptor.callDigest,
        actionDigest: descriptor.actionDigest, deploymentDigest: descriptor.deploymentDigest, token }) };
    });
    if (result.reason) throw new ContractError(`Claude pairing ${result.reason}`);
    return result.receipt;
  }
  completeClaudeHookPairing(receipt, { decisionId } = {}) {
    pairingDescriptor(receipt, true);
    requireValue(text(decisionId), 'Invalid Claude pairing decision');
    const reason = this.#transaction(() => {
      const pair = this.#pair(receipt.key);
      if (!pair) return this.#blockPair(receipt, this.#row(receipt.key) ? 'legacy_unpaired' : 'run_missing');
      if (pair.state === 'blocked') return pair.reason_code ?? 'invalid_state';
      if (pair.token !== receipt.token) return this.#blockPair(receipt, 'token_mismatch', pair);
      if (this.#pairDescriptorMismatch(receipt, pair)) return this.#blockPair(receipt, 'descriptor_mismatch', pair);
      if (receipt.key !== decisionId) return this.#blockPair(receipt, 'decision_mismatch', pair);
      if (pair.state !== 'pending') return this.#blockPair(receipt, 'invalid_state', pair);
      const run = this.#row(receipt.key), mismatch = this.#pairRunMismatch(receipt, run);
      if (mismatch) return this.#blockPair(receipt, mismatch, pair);
      this.#db.prepare("UPDATE claude_hook_pairs SET request_digest=?,state='ready',reason_code=NULL WHERE key=?")
        .run(run.request_digest, receipt.key);
      return null;
    });
    if (reason) throw new ContractError(`Claude pairing ${reason}`);
  }
  blockClaudeHookPairing(receipt, reasonCode = 'before_failed') {
    pairingDescriptor(receipt, true);
    requireValue(PAIR_REASONS.includes(reasonCode), 'Invalid Claude pairing reason');
    this.#transaction(() => {
      const pair = this.#pair(receipt.key);
      requireValue(pair && pair.token === receipt.token && !this.#pairDescriptorMismatch(receipt, pair),
        'Claude pairing token or descriptor mismatch');
      this.#blockPair(receipt, reasonCode, pair);
    });
  }
  observeClaudeHookPairing(descriptor, observation) {
    pairingDescriptor(descriptor);
    const body = outcomeBody(observation);
    const reason = this.#transaction(() => {
      const pair = this.#pair(descriptor.key);
      if (!pair) return this.#blockPair(descriptor, 'unpaired_post');
      if (pair.state === 'blocked') return pair.reason_code ?? 'invalid_state';
      if (pair.state !== 'ready') return this.#blockPair(descriptor, 'early_post', pair);
      if (this.#pairDescriptorMismatch(descriptor, pair)) return this.#blockPair(descriptor, 'descriptor_mismatch', pair);
      const run = this.#row(descriptor.key), mismatch = this.#pairRunMismatch(descriptor, run);
      if (mismatch) return this.#blockPair(descriptor, mismatch, pair);
      if (pair.request_digest !== run.request_digest) return this.#blockPair(descriptor, 'request_mismatch', pair);
      const old = this.#db.prepare('SELECT body FROM observations WHERE run_key=? AND id=?')
        .get(descriptor.key, observation.id);
      if (old && old.body !== body) return this.#blockPair(descriptor, 'outcome_conflict', pair);
      this.#db.prepare('INSERT OR IGNORE INTO observations VALUES(?,?,?)')
        .run(descriptor.key, observation.id, body);
      return null;
    });
    if (reason) throw new ContractError(`Claude pairing ${reason}`);
  }
  pairingSnapshot(key) {
    requireValue(text(key), 'Invalid Claude pairing key');
    if (this.#schemaVersion < 3) return null;
    const pair = this.#pair(key);
    return pair ? snapshot({ state: pair.state, reasonCode: pair.reason_code }) : null;
  }
  #audit(key, kind, details) {
    const latest = this.#db.prepare('SELECT seq FROM audit ORDER BY seq DESC LIMIT 1');
    latest.setReadBigInts(true);
    requireValue((latest.get()?.seq ?? 0n) < MAX_SQLITE_ROWID, 'Audit sequence exhausted');
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
    // Whitelist fields. Model/harness observations are explicitly NOT ground-truth labels.
    const body = outcomeBody(observation);
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
    try {
      const version = this.#db.prepare('PRAGMA user_version').get().user_version;
      requireValue([1, 2, 3, 4].includes(version), 'Unsupported kernel schema');
      this.#schemaVersion = version;
      if (version === 4) inspectAuditArchiveMetadata(this.#db, 4);
      const result = fn(this.#now()); this.#db.exec('COMMIT');
      return result === undefined ? undefined : snapshot(result);
    }
    catch (error) { this.#db.exec('ROLLBACK'); throw error; }
  }
  policyReplayRecord(key) {
    requireValue(text(key), 'Invalid evidence key');
    // Select only the requested run. SQLite measures stored UTF-8 bytes before
    // either JSON body is fetched or parsed; audit, observations and labels are untouched.
    return this.#readEvidence(() => {
      const sizes = this.#db.prepare(`SELECT state,
        length(CAST(evidence AS BLOB)) AS evidence_bytes,
        length(CAST(result AS BLOB)) AS result_bytes
        FROM runs WHERE key=?`).get(key);
      if (!sizes) return null;
      requireValue(sizes.state === 'completed' && sizes.result_bytes !== null,
        'Completed prediction required');
      requireValue(sizes.evidence_bytes > 0 && sizes.evidence_bytes <= 1024 * 1024
        && sizes.result_bytes > 0 && sizes.result_bytes <= 1024 * 1024,
      'Stored replay evidence exceeds size limit');
      const row = this.#db.prepare('SELECT evidence,result FROM runs WHERE key=?').get(key);
      requireValue(row, 'Unknown evidence key');
      let evidence, result;
      try { evidence = JSON.parse(row.evidence); result = JSON.parse(row.result); }
      catch { throw new ContractError('Stored replay evidence is invalid'); }
      const sourceTable = this.#db.prepare("SELECT 1 AS present FROM sqlite_master WHERE type='table' AND name='packs'").get();
      if (!sourceTable) {
        // An old stripped schema-1 fixture can still be replayed, but its
        // stored original verdict must be visibly marked as unverified.
        requireValue(this.#schemaVersion === 1, 'Bound source pack is unavailable for replay');
        return { state: sizes.state, evidence, result, sourceConsistency: 'legacy_unverified' };
      }
      this.#boundPolicyPack(evidence, result);
      return { state: sizes.state, evidence, result, sourceConsistency: 'verified' };
    });
  }
  policyPackTemplate(key) {
    requireValue(text(key), 'Invalid evidence key');
    return this.#readEvidence(() => {
      const sizes = this.#db.prepare(`SELECT state,
        length(CAST(evidence AS BLOB)) AS evidence_bytes,
        length(CAST(result AS BLOB)) AS result_bytes
        FROM runs WHERE key=?`).get(key);
      if (!sizes) return null;
      requireValue(sizes.state === 'completed' && sizes.result_bytes !== null,
        'Completed prediction required');
      requireValue(sizes.evidence_bytes > 0 && sizes.evidence_bytes <= 1024 * 1024
        && sizes.result_bytes > 0 && sizes.result_bytes <= 1024 * 1024,
      'Stored replay evidence exceeds size limit');
      const run = this.#db.prepare('SELECT evidence,result FROM runs WHERE key=?').get(key);
      requireValue(run, 'Unknown evidence key');
      let evidence, result;
      try { evidence = JSON.parse(run.evidence); result = JSON.parse(run.result); }
      catch { throw new ContractError('Stored replay evidence is invalid'); }
      const { pack, sourcePackDigest } = this.#boundPolicyPack(evidence, result);
      return { pack, sourceKey: key, sourcePackDigest };
    });
  }
  #boundPolicyPack(evidence, result) {
    requireValue(typeof result?.provider?.model === 'string',
      'Bound pack or recorded prediction is invalid');
    requireValue(typeof evidence?.binding?.modelId === 'string'
      && result?.provider?.model === evidence.binding.modelId,
      'Recorded provider binding mismatch');
    const reference = evidence?.pack;
    requireValue(reference && text(reference.id) && text(reference.version)
      && hash(reference.digest) && hash(reference.questionsDigest)
      && typeof evidence.eventType === 'string' && evidence.eventType.length > 0,
      'Stored pack binding is invalid');
    const stored = this.#db.prepare(`SELECT digest,
      length(CAST(body AS BLOB)) AS body_bytes FROM packs WHERE id=? AND version=?`)
      .get(reference.id, reference.version);
    requireValue(stored && stored.body_bytes > 0 && stored.body_bytes <= 128 * 1024,
      'Bound pack is unavailable or too large for replay');
    requireValue(stored.digest === reference.digest, 'Bound pack digest mismatch');
    const body = this.#db.prepare('SELECT body FROM packs WHERE id=? AND version=?')
      .get(reference.id, reference.version)?.body;
    let pack, expectedVerdict;
    try {
      pack = JSON.parse(body);
      validatePack(pack);
      const prediction = validateResult(pack.questions, result?.provider);
      expectedVerdict = evaluatePolicy(pack, prediction.answers);
    } catch { throw new ContractError('Bound pack or recorded prediction is invalid'); }
    requireValue(pack.id === reference.id && pack.version === reference.version
      && pack.eventType === evidence.eventType && digest(pack) === reference.digest
      && digest(pack.questions) === reference.questionsDigest,
      'Bound pack contract mismatch');
    let verdictMatches = false;
    try { verdictMatches = canonical(result?.verdict) === canonical(expectedVerdict); }
    catch { /* Invalid stored verdict; do not expose its contents. */ }
    requireValue(verdictMatches, 'Recorded policy verdict mismatch');
    return { pack, sourcePackDigest: reference.digest };
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
  listAttention({ limit = 20, after = '' } = {}) {
    requireValue(Number.isSafeInteger(limit) && limit >= 1 && limit <= 100
      && typeof after === 'string' && after.length <= 1024, 'Invalid attention page');
    return this.#readEvidence(now => {
      const pairing = this.#schemaVersion >= 3 ? `OR EXISTS (
        SELECT 1 FROM claude_hook_pairs p WHERE p.key=r.key AND p.state IN ('pending','blocked'))` : '';
      // Filter before LIMIT: ordinary rows between two attention keys never consume a page.
      // EXISTS uses observations' (run_key,id) primary key; output remains at most limit+1.
      const rows = this.#db.prepare(`SELECT ${evidenceColumns(this.#schemaVersion)} FROM runs r
        WHERE r.key>? AND (
          r.state='unknown' OR (r.state='executing' AND r.lease_until<=?)
          ${pairing}
          OR (r.state='completed' AND json_extract(r.evidence,'$.mode')='shadow'
            AND NOT EXISTS (SELECT 1 FROM observations o WHERE o.run_key=r.key))
          OR EXISTS (SELECT 1 FROM observations o WHERE o.run_key=r.key
            AND COALESCE(json_extract(o.body,'$.status'),'') NOT IN ('succeeded','failed'))
          OR (EXISTS (SELECT 1 FROM observations o WHERE o.run_key=r.key
                AND json_extract(o.body,'$.status')='succeeded')
            AND EXISTS (SELECT 1 FROM observations o WHERE o.run_key=r.key
                AND json_extract(o.body,'$.status')='failed'))
        ) ORDER BY r.key LIMIT ?`).all(after, now, limit + 1);
      const page = rows.slice(0, limit);
      for (const row of page) requireValue(text(row.key), 'Invalid stored evidence key');
      const items = page.map(row => evidenceAttentionView(row, now));
      for (const item of items) requireValue(item.attention.reasons.length > 0, 'Attention filter mismatch');
      return { items, nextCursor: rows.length > limit ? page.at(-1).key : null,
        coverage: { population: 'decision_rows', pairOnlyReservations: 'excluded' } };
    });
  }
  inspect(key) {
    requireValue(text(key), 'Invalid inspection key');
    return this.#readEvidence(() => {
      const row = this.#row(key);
      if (!row) return undefined;
      let archivedRowCount = 0, batchCount = 0;
      if (this.#schemaVersion >= 4) {
        const counts = this.#db.prepare('SELECT COUNT(*) AS batches,COALESCE(SUM(row_count),0) AS rows FROM audit_archive_coverage WHERE run_key=?');
        counts.setReadBigInts(true);
        const value = counts.get(key);
        requireValue(value.batches <= BigInt(Number.MAX_SAFE_INTEGER)
          && value.rows <= BigInt(Number.MAX_SAFE_INTEGER), 'Invalid audit archive history');
        batchCount = Number(value.batches); archivedRowCount = Number(value.rows);
      }
      return { key, state: row.state, epoch: row.epoch, latestRecoveryReview: this.#latestReview(key),
        evidence: JSON.parse(row.evidence), result: row.result ? JSON.parse(row.result) : null,
        audit: this.#db.prepare('SELECT kind,details,at FROM audit WHERE run_key=? ORDER BY seq').all(key).map(r => ({ ...r, details: JSON.parse(r.details) })),
        observations: this.#db.prepare('SELECT body FROM observations WHERE run_key=? ORDER BY id').all(key).map(r => JSON.parse(r.body)),
        labels: this.#db.prepare('SELECT body FROM labels WHERE run_key=? ORDER BY id').all(key).map(r => JSON.parse(r.body)),
        auditHistory: { archived: archivedRowCount > 0, archivedRowCount, batchCount,
          archiveAvailability: 'not_checked' },
      };
    });
  }
  #archiveEntry(key, row) {
    const count = value => {
      requireValue(typeof value === 'bigint' && value >= 0n
        && value <= BigInt(Number.MAX_SAFE_INTEGER), 'Invalid audit archive history');
      return Number(value);
    };
    const current = this.#onlineAudit(key);
    return { batch: { id: row.id, previousId: row.previous_id,
      archiveSha256: row.archive_sha256, archiveBytes: count(row.archive_bytes),
      sourceSchemaVersion: count(row.source_schema_version), sourceLogicalDigest: row.source_logical_digest,
      cutoffAt: count(row.cutoff_at), highwaterSeq: row.highwater_seq.toString(),
      rowCount: count(row.batch_row_count), auditDigest: row.batch_audit_digest,
      committedAt: count(row.committed_at) },
    coverage: { rowCount: count(row.coverage_row_count), minSeq: row.min_seq.toString(),
      maxSeq: row.max_seq.toString(), auditDigest: row.coverage_audit_digest },
    online: current, archiveAvailability: 'not_checked' };
  }
  #onlineAudit(key) {
    const statement = this.#db.prepare('SELECT COUNT(*) AS row_count,MIN(seq) AS min_seq,MAX(seq) AS max_seq FROM audit WHERE run_key=?');
    statement.setReadBigInts(true);
    const row = statement.get(key);
    requireValue(row.row_count >= 0n && row.row_count <= BigInt(Number.MAX_SAFE_INTEGER),
      'Invalid audit archive history');
    return { rowCount: Number(row.row_count), minSeq: row.min_seq?.toString() ?? null,
      maxSeq: row.max_seq?.toString() ?? null };
  }
  #archiveSelect() {
    return `SELECT b.id,b.previous_id,b.archive_sha256,b.archive_bytes,b.source_schema_version,
      b.source_logical_digest,b.cutoff_at,b.highwater_seq,b.row_count AS batch_row_count,
      b.audit_digest AS batch_audit_digest,b.committed_at,
      c.row_count AS coverage_row_count,c.min_seq,c.max_seq,c.audit_digest AS coverage_audit_digest
      FROM audit_archive_coverage c JOIN audit_archive_batches b ON b.id=c.batch_id`;
  }
  auditArchiveBatch(key, batchId) {
    requireValue(text(key) && hash(batchId), 'Invalid audit archive lookup');
    return this.#readEvidence(() => {
      if (this.#schemaVersion < 4 || !this.#row(key)) return null;
      const statement = this.#db.prepare(`${this.#archiveSelect()} WHERE c.run_key=? AND b.id=?`);
      statement.setReadBigInts(true);
      const row = statement.get(key, batchId);
      return row ? this.#archiveEntry(key, row) : null;
    });
  }
  auditArchiveHistory(key, { after = '', limit = 20 } = {}) {
    requireValue(text(key) && (after === '' || hash(after)) && Number.isSafeInteger(limit)
      && limit >= 1 && limit <= 50, 'Invalid audit archive page');
    return this.#readEvidence(() => {
      if (!this.#row(key)) return null;
      if (this.#schemaVersion < 4) return { items: [], nextCursor: null,
        archived: false, archivedRowCount: 0, batchCount: 0, online: this.#onlineAudit(key),
        archiveAvailability: 'not_checked' };
      const totals = this.#db.prepare('SELECT COUNT(*) AS batches,COALESCE(SUM(row_count),0) AS rows FROM audit_archive_coverage WHERE run_key=?');
      totals.setReadBigInts(true);
      const total = totals.get(key);
      requireValue(total.batches <= BigInt(Number.MAX_SAFE_INTEGER)
        && total.rows <= BigInt(Number.MAX_SAFE_INTEGER), 'Invalid audit archive history');
      const statement = this.#db.prepare(`${this.#archiveSelect()} WHERE c.run_key=? AND b.id>?
        ORDER BY b.id LIMIT ?`);
      statement.setReadBigInts(true);
      const rows = statement.all(key, after, limit + 1);
      return { items: rows.slice(0, limit).map(row => this.#archiveEntry(key, row)),
        nextCursor: rows.length > limit ? rows[limit - 1].id : null,
        archived: total.rows > 0n, archivedRowCount: Number(total.rows),
        batchCount: Number(total.batches), online: this.#onlineAudit(key),
        archiveAvailability: 'not_checked' };
    });
  }
  storageSnapshot(options = {}) {
    const input = snapshot(options);
    requireValue(input && typeof input === 'object' && !Array.isArray(input)
      && Object.keys(input).every(key => key === 'scanLimit'), 'Invalid storage options');
    const scanLimit = Object.hasOwn(input, 'scanLimit') ? input.scanLimit : 1000;
    requireValue(Number.isSafeInteger(scanLimit) && scanLimit >= 1 && scanLimit <= 10000, 'Invalid storage scan limit');
    // This transaction takes one SQLite read snapshot, even on a read-only or
    // historical connection. It never parses or selects application JSON.
    this.#db.exec('BEGIN');
    try {
      const ledgerSchemaVersion = this.#db.prepare('PRAGMA user_version').get().user_version;
      requireValue([1, 2, 3, 4].includes(ledgerSchemaVersion), 'Unsupported kernel schema');
      this.#schemaVersion = ledgerSchemaVersion;
      const pages = {
        pageSize: this.#db.prepare('PRAGMA page_size').get().page_size,
        pageCount: this.#db.prepare('PRAGMA page_count').get().page_count,
        freelistCount: this.#db.prepare('PRAGMA freelist_count').get().freelist_count,
      };
      const rows = {};
      for (const table of storageTables(ledgerSchemaVersion)) {
        if (table === 'recovery_reviews' && ledgerSchemaVersion < 2
          || table === 'claude_hook_pairs' && ledgerSchemaVersion < 3) {
          rows[table] = null;
        } else if (table === 'runs') {
          rows[table] = this.#db.prepare('SELECT state FROM runs LIMIT ?').all(scanLimit + 1);
        } else if (table === 'claude_hook_pairs') {
          rows[table] = this.#db.prepare(`SELECT p.state AS state,
            NOT EXISTS (SELECT 1 FROM runs r WHERE r.key=p.key) AS pairOnly
            FROM claude_hook_pairs p LIMIT ?`).all(scanLimit + 1);
        } else {
          // `table` is from STORAGE_TABLES only; no user-controlled identifier.
          rows[table] = this.#db.prepare(`SELECT 1 AS present FROM ${table} LIMIT ?`).all(scanLimit + 1);
        }
      }
      const projected = storageView({ ledgerSchemaVersion, scanLimit, pages, rows });
      this.#db.exec('COMMIT');
      return projected;
    } catch (error) { this.#db.exec('ROLLBACK'); throw error; }
  }
  close() { this.#db.close(); }
}

import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { SqliteKernel, digest } from '../adapters/sqlite-kernel.mjs';

const prefix = 'reflexmesh-storage-kernel-';
function fixture(t) {
  const root = realpathSync(tmpdir()), dir = mkdtempSync(join(root, prefix)), path = join(dir, 'ledger.sqlite');
  const kernels = new Set();
  t.after(() => {
    for (const kernel of kernels) kernel.close();
    const target = realpathSync(dir);
    assert.equal(dirname(target).toLowerCase(), root.toLowerCase());
    assert.ok(basename(target).startsWith(prefix));
    rmSync(target, { recursive: true, force: true });
  });
  return { path,
    open(options = {}) { const kernel = new SqliteKernel(path, options); kernels.add(kernel); return kernel; },
    close(kernel) { kernel.close(); kernels.delete(kernel); },
  };
}
function claim(kernel, key) {
  const requestDigest = digest(`request-${key}`);
  const outcome = kernel.claim({ key, requestDigest, owner: 'fixture', leaseMs: 10000,
    evidence: { mode: 'shadow', privateBody: 'PRIVATE_STATE_NOT_FOR_STORAGE_REPORT' } });
  assert.equal(outcome.kind, 'claimed');
  return { handle: outcome.handle, requestDigest };
}
function descriptor(key) { return { key, callDigest: digest(`call-${key}`), actionDigest: digest(`action-${key}`),
  deploymentDigest: digest(`deployment-${key}`) }; }
function rowHash(path, version) {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const tables = ['packs', 'runs', 'audit', 'observations', 'labels',
      ...(version >= 2 ? ['recovery_reviews'] : []), ...(version >= 3 ? ['claude_hook_pairs'] : [])];
    const rows = Object.fromEntries(tables.map(name => [name, db.prepare(`SELECT * FROM ${name}`).all()]));
    return createHash('sha256').update(JSON.stringify(rows)).digest('hex');
  } finally { db.close(); }
}

test('read-only snapshot counts all seven schema-3 tables and states without revealing content or changing rows', t => {
  const f = fixture(t), writer = f.open();
  const admitted = claim(writer, 'run-admitted');
  const executing = claim(writer, 'run-executing');
  writer.append(executing.handle, { kind: 'action.started', details: { marker: 'PRIVATE_AUDIT_MARKER' } });
  const completed = claim(writer, 'run-completed');
  writer.complete(completed.handle, { status: 'shadow', verdict: { effect: 'escalate', ruleId: 'fixture' },
    output: 'PRIVATE_RESULT_NOT_FOR_STORAGE_REPORT' });
  writer.observe('run-completed', { id: 'observation', status: 'unknown', provenance: 'harness-reported',
    evidenceDigest: digest('PRIVATE_OBSERVATION_NOT_FOR_STORAGE_REPORT') });
  const unknown = claim(writer, 'run-unknown'); writer.abandon(unknown.handle);
  const pending = descriptor('pair-only-pending'); writer.beginClaudeHookPairing(pending);
  const blocked = descriptor('pair-only-blocked');
  const blockedReceipt = writer.beginClaudeHookPairing(blocked); writer.blockClaudeHookPairing(blockedReceipt);
  const exactEvidence = { actionDigest: digest('ready-action'), pack: { digest: digest('pack') },
    binding: { providerId: 'fixture' }, mode: 'shadow' };
  const readyGood = { key: 'pair-ready-good', callDigest: digest('ready-call'),
    actionDigest: exactEvidence.actionDigest,
    deploymentDigest: digest({ packDigest: exactEvidence.pack.digest, binding: exactEvidence.binding, mode: exactEvidence.mode }) };
  const goodReceipt = writer.beginClaudeHookPairing(readyGood);
  writer.claim({ key: readyGood.key, requestDigest: digest('ready-good-request'), owner: 'fixture', leaseMs: 10000,
    evidence: exactEvidence });
  writer.completeClaudeHookPairing(goodReceipt, { decisionId: readyGood.key });
  f.close(writer);
  const db = new DatabaseSync(f.path);
  try {
    db.prepare('INSERT INTO labels VALUES(?,?,?)').run('run-completed', 'label', '{"private":"PRIVATE_LABEL_BODY"}');
    db.prepare('INSERT INTO recovery_reviews VALUES(?,?,?,?,?,?)').run('run-unknown', 'review',
      '{"private":"PRIVATE_REVIEW_BODY"}', digest('review'), 3, 123);
  } finally { db.close(); }
  const before = rowHash(f.path, 3), reader = f.open({ readOnly: true });
  const report = reader.storageSnapshot();
  assert.equal(report.ledgerSchemaVersion, 3);
  assert.equal(report.scanLimit, 1000);
  assert.deepEqual(report.runStates.counts, { admitted: 2, executing: 1, completed: 1, unknown: 1 });
  assert.deepEqual(report.pairStates.counts, { pending: 1, ready: 1, blocked: 1 });
  assert.equal(report.pairStates.pairOnly, 2);
  assert.equal(report.tables.runs.total, 5);
  assert.equal(report.tables.claude_hook_pairs.total, 3);
  assert.equal(report.tables.labels.total, 1);
  assert.equal(report.tables.recovery_reviews.total, 1);
  assert.equal(report.tables.observations.total, 1);
  assert.ok(report.tables.audit.total >= 7);
  assert.equal(report.pages.logicalBytes, report.pages.pageSize * report.pages.pageCount);
  assert.equal(report.pages.reusableBytes, report.pages.pageSize * report.pages.freelistCount);
  assert.equal(Object.isFrozen(report.tables), true);
  const encoded = JSON.stringify(report);
  for (const secret of ['run-admitted', 'pair-only-pending', blockedReceipt.token,
    'PRIVATE_STATE_NOT_FOR_STORAGE_REPORT', 'PRIVATE_RESULT_NOT_FOR_STORAGE_REPORT',
    'PRIVATE_LABEL_BODY', 'PRIVATE_REVIEW_BODY', 'PRIVATE_AUDIT_MARKER'])
    assert.equal(encoded.includes(secret), false);
  assert.equal(rowHash(f.path, 3), before);
  f.close(reader);
  const retry = f.open();
  assert.equal(retry.claim({ key: 'run-unknown', requestDigest: unknown.requestDigest, owner: 'other',
    leaseMs: 10000, evidence: {} }).kind, 'unknown');
  assert.equal(retry.claim({ key: 'run-completed', requestDigest: completed.requestDigest, owner: 'other',
    leaseMs: 10000, evidence: {} }).kind, 'replay');
  assert.deepEqual(retry.storageSnapshot().runStates.counts, report.runStates.counts);
});

test('scan limit uses one lookahead, reports null totals and keeps pair-only bounded to pair sample', t => {
  const f = fixture(t), writer = f.open();
  for (let i = 0; i < 5; i++) claim(writer, `run-${i}`);
  for (let i = 0; i < 4; i++) writer.beginClaudeHookPairing(descriptor(`pair-only-${i}`));
  f.close(writer);
  const reader = f.open({ readOnly: true }), page = reader.storageSnapshot({ scanLimit: 2 });
  assert.deepEqual(page.tables.runs, { supported: true, scanned: 2, truncated: true, total: null });
  assert.deepEqual(page.tables.claude_hook_pairs, { supported: true, scanned: 2, truncated: true, total: null });
  assert.deepEqual(page.tables.audit, { supported: true, scanned: 2, truncated: true, total: null });
  assert.equal(Object.values(page.runStates.counts).reduce((sum, n) => sum + n, 0), 2);
  assert.equal(Object.values(page.pairStates.counts).reduce((sum, n) => sum + n, 0), 2);
  assert.equal(page.pairStates.pairOnly, 2);
  assert.equal(reader.storageSnapshot({ scanLimit: 10 }).tables.runs.total, 5);
});

test('one read transaction keeps a pre-commit cohort when another connection writes between table scans', t => {
  const f = fixture(t), writer = f.open(), reader = f.open({ readOnly: true });
  const originalPrepare = DatabaseSync.prototype.prepare;
  let inserted = false;
  DatabaseSync.prototype.prepare = function (sql) {
    const statement = originalPrepare.call(this, sql);
    if (sql !== 'SELECT 1 AS present FROM packs LIMIT ?') return statement;
    return new Proxy(statement, { get(target, property) {
      if (property !== 'all') return Reflect.get(target, property, target);
      return (...args) => {
        const rows = target.all(...args); // The reader's first table SELECT pins its snapshot.
        if (!inserted) { inserted = true; claim(writer, 'inserted-between-scans'); }
        return rows;
      };
    } });
  };
  let first;
  try { first = reader.storageSnapshot(); }
  finally { DatabaseSync.prototype.prepare = originalPrepare; }
  assert.equal(inserted, true);
  assert.equal(first.tables.runs.total, 0);
  assert.equal(first.tables.audit.total, 0);
  const second = reader.storageSnapshot();
  assert.equal(second.tables.runs.total, 1);
  assert.equal(second.tables.audit.total, 1);
});

test('projection failure rolls back the read transaction so the same connection can read again', t => {
  const f = fixture(t), writer = f.open();
  claim(writer, 'persisted-run');
  f.close(writer);
  const before = rowHash(f.path, 3), reader = f.open({ readOnly: true });
  const originalPrepare = DatabaseSync.prototype.prepare;
  let injected = false;
  DatabaseSync.prototype.prepare = function (sql) {
    const statement = originalPrepare.call(this, sql);
    if (sql !== 'SELECT state FROM runs LIMIT ?') return statement;
    return new Proxy(statement, { get(target, property) {
      if (property !== 'all') return Reflect.get(target, property, target);
      return (...args) => {
        target.all(...args); // Execute the real SELECT, then corrupt only the test seam's returned projection row.
        injected = true;
        return [{ state: 'INVALID_SYNTHETIC_STATE' }];
      };
    } });
  };
  try { assert.throws(() => reader.storageSnapshot(), /Invalid run scan state/); }
  finally { DatabaseSync.prototype.prepare = originalPrepare; }
  assert.equal(injected, true);
  const recovered = reader.storageSnapshot(); // A leaked BEGIN would fail before this SELECT.
  assert.equal(recovered.tables.runs.total, 1);
  assert.equal(recovered.runStates.counts.admitted, 1);
  assert.equal(rowHash(f.path, 3), before);
});

for (const version of [1, 2]) test(`historical schema ${version} snapshot neither migrates nor invents unsupported tables`, t => {
  const f = fixture(t), writer = f.open();
  const run = claim(writer, 'historical');
  writer.complete(run.handle, { status: 'shadow', verdict: { effect: 'escalate', ruleId: 'fixture' } });
  f.close(writer);
  const downgrade = new DatabaseSync(f.path);
  try { downgrade.exec(`DROP TABLE claude_hook_pairs; ${version === 1 ? 'DROP TABLE recovery_reviews;' : ''}
    PRAGMA user_version=${version};`); }
  finally { downgrade.close(); }
  const before = rowHash(f.path, version), reader = f.open({ readOnly: true });
  const report = reader.storageSnapshot();
  assert.equal(report.ledgerSchemaVersion, version);
  assert.equal(report.tables.runs.total, 1);
  assert.deepEqual(report.tables.claude_hook_pairs, { supported: false, scanned: null, truncated: null, total: null });
  assert.equal(report.pairStates.counts, null);
  assert.equal(report.pairStates.pairOnly, null);
  if (version === 1) assert.deepEqual(report.tables.recovery_reviews,
    { supported: false, scanned: null, truncated: null, total: null });
  else assert.deepEqual(report.tables.recovery_reviews,
    { supported: true, scanned: 0, truncated: false, total: 0 });
  f.close(reader);
  assert.equal(rowHash(f.path, version), before);
  const check = new DatabaseSync(f.path, { readOnly: true });
  try { assert.equal(check.prepare('PRAGMA user_version').get().user_version, version); }
  finally { check.close(); }
});

test('storage options reject extra, malformed, accessor and out-of-bound scan limits', t => {
  const f = fixture(t), kernel = f.open();
  for (const options of [null, [], { scanLimit: null }, { scanLimit: 0 }, { scanLimit: 10001 }, { scanLimit: 1.5 },
    { scanLimit: '2' }, { scanLimit: NaN }, { scanLimit: undefined }, { extra: true }])
    assert.throws(() => kernel.storageSnapshot(options));
  let getterCalls = 0;
  const accessor = Object.defineProperty({}, 'scanLimit', { enumerable: true, get() { getterCalls++; return 10; } });
  assert.throws(() => kernel.storageSnapshot(accessor), /accessor/);
  assert.equal(getterCalls, 0);
  assert.equal(kernel.storageSnapshot({ scanLimit: 10000 }).scanLimit, 10000);
});

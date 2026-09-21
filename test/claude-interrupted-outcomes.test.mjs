import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { fromClaudeHook } from '../dist/index.js';
import { SqliteKernel, digest } from '../adapters/sqlite-kernel.mjs';
import { IntentCache } from '../adapters/intent-cache.mjs';
import { diagnoseClaudeDoctor, formatClaudeDoctor } from '../adapters/claude-doctor.mjs';
import { formatEvidence } from '../adapters/evidence-cli.mjs';

const hook = (event, callId = 'read-one', fields = {}) => ({ hook_event_name: event,
  session_id: 'synthetic-session', tool_use_id: callId, tool_name: 'Read',
  tool_input: { file_path: 'synthetic-file' }, ...fields });
const warning = /ReflexMesh (shadow|task) observation unavailable/;
const sqliteWarningOnly = /^(?:\(node:\d+\) ExperimentalWarning: SQLite is an experimental feature and might change at any time\r?\n\(Use `node --trace-warnings \.\.\.` to show where the warning was created\)\r?\n)?$/;
function assertSuccessfulHook(child) {
  assert.match(child.stderr, sqliteWarningOnly);
  return child;
}

function fixture(t, entry, envOverrides = {}) {
  const root = mkdtempSync(join(tmpdir(), 'reflexmesh-claude-interrupt-'));
  t.after(() => {
    const target = realpathSync(root);
    assert.equal(dirname(target), realpathSync(tmpdir()));
    assert.ok(basename(target).startsWith('reflexmesh-claude-interrupt-'));
    rmSync(target, { recursive: true, force: true });
  });
  const dbPath = join(root, 'ledger.sqlite');
  const env = { PATH: process.env.PATH, REFLEXMESH_DB: dbPath, REFLEXMESH_PROVIDER: 'abstain',
    REFLEXMESH_ALLOW_REMOTE: 'false', REFLEXMESH_TENANT: 'synthetic',
    REFLEXMESH_SCOPE: 'interrupted-outcomes', REFLEXMESH_INTENT_MODE: 'off',
    REFLEXMESH_INTENT_DB: join(root, 'intents.sqlite'),
    REFLEXMESH_TASK_EVIDENCE: entry === 'claude-task-hook' ? 'true' : 'false',
    ...envOverrides };
  const command = fileURLToPath(new URL(`../adapters/${entry}.mjs`, import.meta.url));
  const run = payload => {
    const child = spawnSync(process.execPath, [command], { env, input: JSON.stringify(payload),
      encoding: 'utf8', timeout: 7000, maxBuffer: 256000 });
    assert.equal(child.error, undefined);
    assert.equal(child.status, 0, child.stderr);
    assert.deepEqual(JSON.parse(child.stdout), {});
    return child;
  };
  const read = () => {
    const kernel = new SqliteKernel(dbPath, { readOnly: true });
    try {
      const page = kernel.listEvidence();
      const item = page.items[0] ?? null;
      return { page, item, raw: item ? kernel.inspect(item.key) : null };
    } finally { kernel.close(); }
  };
  return { dbPath, env, run, read };
}

test('failure normalization uses only an optional boolean interruption flag', () => {
  const error = 'synthetic-private-error';
  for (const [fields, status] of [[{}, 'failed'], [{ is_interrupt: false }, 'failed'],
    [{ is_interrupt: true }, 'unknown']]) {
    const normalized = fromClaudeHook(hook('PostToolUseFailure', 'read-one', { error, ...fields }));
    assert.equal(normalized.phase, 'after');
    assert.equal(normalized.status, status);
    assert.equal(normalized.evidence, error);
  }
  for (const value of ['true', 1, 0, null, [], {}]) {
    assert.throws(() => fromClaudeHook(hook('PostToolUseFailure', 'read-one',
      { error, is_interrupt: value })), /Invalid Claude interruption flag/);
  }
  assert.throws(() => fromClaudeHook(hook('PostToolUseFailure', 'read-one',
    { error, is_interrupt: undefined })), /Non-JSON value/);
  for (const fields of [{ error }, { is_interrupt: false }, { is_interrupt: true }]) {
    assert.throws(() => fromClaudeHook(hook('PostToolUse', 'read-one',
      { tool_response: {}, ...fields })), /Failure fields on successful Claude hook/);
  }
  assert.equal(fromClaudeHook(hook('PostToolUse', 'read-one', { tool_response: {} })).status,
    'succeeded');
});

for (const entry of ['claude-hook', 'claude-task-hook']) {
  for (const [interrupt, status] of [[true, 'unknown'], [false, 'failed']]) {
    test(`${entry} separate pre/failure processes retain ${status} as reported outcome`, async t => {
      const f = fixture(t, entry), error = 'PRIVATE_SYNTHETIC_FAILURE';
      assertSuccessfulHook(f.run(hook('PreToolUse')));
      const admitted = f.read();
      assert.equal(admitted.item.run.state, 'completed');
      assert.equal(admitted.item.hostOutcome.count, 0);
      assert.deepEqual(admitted.item.hostOutcome.hookPairing,
        { state: 'ready', reasonCode: null });
      assertSuccessfulHook(f.run(hook('PostToolUseFailure', 'read-one',
        { error, is_interrupt: interrupt })));
      const { page, item, raw } = f.read();
      assert.equal(item.run.state, 'completed');
      assert.equal(item.run.resultStatus, 'shadow');
      assert.equal(item.hostOutcome.status, status);
      assert.equal(item.hostOutcome.count, 1);
      assert.deepEqual(item.hostOutcome.byProvenance,
        [{ status, provenance: 'harness-reported', count: 1 }]);
      assert.deepEqual(item.hostOutcome.hookPairing, { state: 'ready', reasonCode: null });
      assert.equal(item.recovery.required, false);
      assert.equal(item.recovery.executionAllowed, false);
      assert.equal(item.labelCount, 0);
      assert.equal(raw.observations[0].status, status);
      assert.equal(raw.observations[0].evidenceDigest, digest(error));
      assert.deepEqual(raw.labels, []);
      assert.equal(JSON.stringify(raw).includes(error), false);
      assert.match(formatEvidence(page, 'list'), new RegExp(`host outcome: ${status}`));
      assert.match(formatEvidence(item, 'inspect'), new RegExp(`Host outcome: ${status}; observations: 1; labels: 0`));
      const doctor = await diagnoseClaudeDoctor(['--db', f.dbPath, '--tenant', 'synthetic',
        '--scope', 'interrupted-outcomes', '--key', item.key], { platform: 'linux' });
      assert.equal(doctor.report.historicalEvidence.runState, 'completed');
      assert.equal(doctor.report.historicalEvidence.outcomeStatus, status);
      assert.deepEqual(doctor.report.historicalEvidence.outcomeByProvenance,
        [{ status, provenance: 'harness-reported', count: 1 }]);
      assert.equal(doctor.report.historicalEvidence.recoveryRequired, false);
      assert.equal(doctor.report.historicalEvidence.hookPairingState, 'ready');
      assert.equal(doctor.report.liveHost, 'live_host_unverified');
      assert.match(formatClaudeDoctor(doctor.report), new RegExp(`harness-reported:${status}=1`));
      assert.equal(JSON.stringify(doctor.report).includes(error), false);
      assert.equal(doctor.report.diagnostics.some(d => d.code === 'historical_unknown_execution'),
        status === 'unknown');
    });
  }

  test(`${entry} malformed interruption cannot record an outcome or alter host response`, t => {
    const f = fixture(t, entry);
    assertSuccessfulHook(f.run(hook('PreToolUse')));
    const before = f.read();
    const invalid = f.run(hook('PostToolUseFailure', 'read-one',
      { error: 'PRIVATE_SYNTHETIC_FAILURE', is_interrupt: 'true' }));
    assert.match(invalid.stderr, warning);
    const after = f.read();
    assert.deepEqual(after.raw, before.raw);
    assert.equal(after.item.hostOutcome.count, 0);
    assert.deepEqual(after.item.hostOutcome.hookPairing,
      { state: 'ready', reasonCode: null });
  });

  test(`${entry} conflicting failure reports block pairing without rewriting first observation`, t => {
    const f = fixture(t, entry), error = 'PRIVATE_SYNTHETIC_FAILURE';
    assertSuccessfulHook(f.run(hook('PreToolUse')));
    assertSuccessfulHook(f.run(hook('PostToolUseFailure', 'read-one',
      { error, is_interrupt: true })));
    const first = f.read();
    assert.match(f.run(hook('PostToolUseFailure', 'read-one',
      { error, is_interrupt: false })).stderr, warning);
    const second = f.read();
    assert.deepEqual(second.raw, first.raw);
    assert.equal(second.item.hostOutcome.status, 'unknown');
    assert.deepEqual(second.item.hostOutcome.hookPairing,
      { state: 'blocked', reasonCode: 'outcome_conflict' });
    assert.equal(second.item.hostOutcome.count, 1);
    assert.equal(second.item.labelCount, 0);
  });
}

test('task hook old interrupted post preserves a newer explicit summary and old pairing', t => {
  const f = fixture(t, 'claude-task-hook', { REFLEXMESH_INTENT_MODE: 'explicit-summary' });
  const scope = { harness: 'claude-code', sessionId: 'synthetic-session', agentId: 'root' };
  const current = () => {
    const cache = new IntentCache(f.env.REFLEXMESH_INTENT_DB,
      { tenantId: 'synthetic', scope: 'interrupted-outcomes' });
    try { return cache.current(scope); } finally { cache.close(); }
  };
  assertSuccessfulHook(f.run(hook('UserPromptSubmit', 'prompt',
    { prompt: 'ReflexMesh-Intent: Old synthetic task' })));
  assertSuccessfulHook(f.run(hook('PreToolUse', 'read-one')));
  const old = f.read().item;
  assert.equal(old.taskEvidence.recordedStatus, 'ready');
  assert.equal(old.taskEvidence.summaryDigest, digest('Old synthetic task'));
  assert.deepEqual(old.hostOutcome.hookPairing, { state: 'ready', reasonCode: null });

  assertSuccessfulHook(f.run(hook('UserPromptSubmit', 'prompt',
    { prompt: 'ReflexMesh-Intent: New synthetic task' })));
  const newer = current();
  assert.equal(newer.summary, 'New synthetic task');
  assertSuccessfulHook(f.run(hook('PostToolUseFailure', 'read-one',
    { error: 'PRIVATE_SYNTHETIC_INTERRUPTION', is_interrupt: true })));
  const afterOldPost = f.read().item;
  assert.equal(afterOldPost.key, old.key);
  assert.equal(afterOldPost.run.state, 'completed');
  assert.equal(afterOldPost.hostOutcome.status, 'unknown');
  assert.deepEqual(afterOldPost.hostOutcome.hookPairing, { state: 'ready', reasonCode: null });
  assert.equal(afterOldPost.taskEvidence.summaryDigest, old.taskEvidence.summaryDigest);
  assert.deepEqual(current(), newer);

  assertSuccessfulHook(f.run(hook('PreToolUse', 'read-two',
    { tool_input: { file_path: 'synthetic-new-file' } })));
  const page = f.read().page;
  const newCall = page.items.find(item => item.key !== old.key);
  assert.ok(newCall);
  assert.equal(newCall.taskEvidence.recordedStatus, 'ready');
  assert.equal(newCall.taskEvidence.summaryDigest, digest('New synthetic task'));
  assert.notEqual(newCall.taskEvidence.summaryDigest, old.taskEvidence.summaryDigest);
  assert.equal(newCall.hostOutcome.count, 0);
  assert.deepEqual(newCall.hostOutcome.hookPairing, { state: 'ready', reasonCode: null });
  assert.equal(page.items.find(item => item.key === old.key).hostOutcome.status, 'unknown');
  assert.deepEqual(current(), newer);
});

test('schema 2 historical failure remains failed and unpaired after writable migration', async t => {
  const f = fixture(t, 'claude-hook');
  const legacy = { id: 'old-outcome', status: 'failed', provenance: 'harness-reported',
    evidenceDigest: digest('old-error') };
  const db = new DatabaseSync(f.dbPath);
  try {
    db.exec(`CREATE TABLE packs (id TEXT NOT NULL,version TEXT NOT NULL,digest TEXT NOT NULL,body TEXT NOT NULL,PRIMARY KEY(id,version)) STRICT;
      CREATE TABLE runs (key TEXT PRIMARY KEY,request_digest TEXT NOT NULL,state TEXT NOT NULL CHECK(state IN ('admitted','executing','completed','unknown')),epoch INTEGER NOT NULL,owner TEXT NOT NULL,lease_until INTEGER NOT NULL,evidence TEXT NOT NULL,result TEXT) STRICT;
      CREATE TABLE audit (seq INTEGER PRIMARY KEY,run_key TEXT NOT NULL REFERENCES runs(key),kind TEXT NOT NULL,details TEXT NOT NULL,at INTEGER NOT NULL) STRICT;
      CREATE TABLE observations (run_key TEXT NOT NULL REFERENCES runs(key),id TEXT NOT NULL,body TEXT NOT NULL,PRIMARY KEY(run_key,id)) STRICT;
      CREATE TABLE labels (run_key TEXT NOT NULL REFERENCES runs(key),id TEXT NOT NULL,body TEXT NOT NULL,PRIMARY KEY(run_key,id)) STRICT;
      CREATE TABLE recovery_reviews (run_key TEXT NOT NULL REFERENCES runs(key),id TEXT NOT NULL,body TEXT NOT NULL,digest TEXT NOT NULL,applied_epoch INTEGER NOT NULL,at INTEGER NOT NULL,PRIMARY KEY(run_key,id),UNIQUE(run_key,applied_epoch)) STRICT;
      PRAGMA user_version=2;`);
    db.prepare('INSERT INTO runs VALUES(?,?,?,?,?,?,?,?)').run('legacy', digest('request'),
      'completed', 1, 'old', 100, '{}', '{}');
    db.prepare('INSERT INTO observations VALUES(?,?,?)').run('legacy', legacy.id, JSON.stringify(legacy));
  } finally { db.close(); }
  const before = f.read();
  assert.equal(before.item.hostOutcome.status, 'failed');
  assert.deepEqual(before.item.hostOutcome.hookPairing, { state: 'not_recorded', reasonCode: null });
  const writable = new SqliteKernel(f.dbPath);
  try {
    assert.equal(writable.pairingSnapshot('legacy'), null);
    assert.deepEqual(writable.inspect('legacy').observations, [legacy]);
  } finally { writable.close(); }
  const after = f.read();
  assert.deepEqual(after.raw.observations, before.raw.observations);
  assert.equal(after.item.hostOutcome.status, 'failed');
  assert.deepEqual(after.item.hostOutcome.hookPairing, { state: 'not_recorded', reasonCode: null });
  const doctor = await diagnoseClaudeDoctor(['--db', f.dbPath, '--tenant', 'synthetic',
    '--scope', 'interrupted-outcomes', '--key', 'legacy'], { platform: 'linux' });
  assert.equal(doctor.report.historicalEvidence.outcomeStatus, 'failed');
  assert.equal(doctor.report.historicalEvidence.hookPairingState, 'not_recorded');
});

import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { SqliteKernel, digest } from '../adapters/sqlite-kernel.mjs';

const pairingWorker = new URL('./fixtures/claude-hook-pairing-racer.mjs', import.meta.url);
const deployment = { packDigest: digest('pack'), binding: { providerId: 'abstain' }, mode: 'shadow' };
const descriptor = (key = 'pair') => ({ key, callDigest: digest('call'), actionDigest: digest('action'),
  deploymentDigest: digest(deployment) });
const observation = { id: 'outcome', status: 'succeeded', provenance: 'harness-reported', evidenceDigest: digest('output') };
const directories = new Set();
after(() => {
  const temporaryRoot = realpathSync(tmpdir());
  // Test-local cleanup only: never follow a replaced path outside the temp root.
  for (const dir of directories) {
    const target = realpathSync(dir);
    assert.equal(dirname(target), temporaryRoot);
    assert.ok(basename(target).startsWith('reflexmesh-pairing-kernel-'));
    rmSync(target, { recursive: true, force: true });
  }
});
function file(t) {
  const dir = mkdtempSync(join(tmpdir(), 'reflexmesh-pairing-kernel-'));
  directories.add(dir);
  return join(dir, 'ledger.sqlite');
}
function sql(path, action) {
  const db = new DatabaseSync(path);
  try { return action(db); } finally { db.close(); }
}
function admit(kernel, d, overrides = {}) {
  const evidence = { actionDigest: d.actionDigest, pack: { digest: deployment.packDigest },
    binding: deployment.binding, mode: deployment.mode, ...overrides };
  return kernel.claim({ key: d.key, requestDigest: digest({ key: d.key }), owner: 'fixture', leaseMs: 10000,
    evidence });
}
function ready(kernel, d = descriptor()) {
  const receipt = kernel.beginClaudeHookPairing(d);
  admit(kernel, d);
  kernel.completeClaudeHookPairing(receipt, { decisionId: d.key });
  return receipt;
}
function reopened(t) {
  const path = file(t), first = new SqliteKernel(path);
  return { path, first, reopen: () => new SqliteKernel(path) };
}

test('schema 3 pairing receipt survives reopen; read-only view exposes no token', t => {
  const { path, first } = reopened(t), d = descriptor();
  const receipt = first.beginClaudeHookPairing(d);
  assert.ok(Object.isFrozen(receipt));
  assert.match(receipt.token, /^[a-f0-9-]{36}$/);
  admit(first, d);
  first.close();
  const second = new SqliteKernel(path);
  second.completeClaudeHookPairing(receipt, { decisionId: d.key });
  second.close();
  const reader = new SqliteKernel(path, { readOnly: true });
  assert.deepEqual(reader.pairingSnapshot(d.key), { state: 'ready', reasonCode: null });
  assert.equal(JSON.stringify(reader.pairingSnapshot(d.key)).includes(receipt.token), false);
  assert.throws(() => reader.beginClaudeHookPairing(descriptor('other')), /Read-only/);
  reader.close();
  sql(path, db => assert.equal(db.prepare('PRAGMA user_version').get().user_version, 3));
});

test('duplicate before permanently poisons even an identical ready pairing', t => {
  const k = new SqliteKernel(file(t)); t.after(() => k.close());
  const d = descriptor(), receipt = ready(k, d);
  assert.throws(() => k.beginClaudeHookPairing(d), /duplicate_pre/);
  assert.deepEqual(k.pairingSnapshot(d.key), { state: 'blocked', reasonCode: 'duplicate_pre' });
  assert.throws(() => k.completeClaudeHookPairing(receipt, { decisionId: d.key }), /duplicate_pre/);
  assert.throws(() => k.observeClaudeHookPairing(d, observation), /duplicate_pre/);
  assert.deepEqual(k.inspect(d.key).observations, []);
});

test('early post and missing post persist irreversible blocks; late complete cannot revive', t => {
  const path = file(t), k = new SqliteKernel(path), d = descriptor();
  const receipt = k.beginClaudeHookPairing(d);
  assert.throws(() => k.observeClaudeHookPairing(d, observation), /early_post/);
  admit(k, d);
  assert.throws(() => k.completeClaudeHookPairing(receipt, { decisionId: d.key }), /early_post/);
  assert.throws(() => k.beginClaudeHookPairing(d), /early_post/);
  k.close();
  const next = new SqliteKernel(path);
  assert.deepEqual(next.pairingSnapshot(d.key), { state: 'blocked', reasonCode: 'early_post' });
  const absent = descriptor('absent');
  assert.throws(() => next.observeClaudeHookPairing(absent, observation), /unpaired_post/);
  assert.throws(() => next.beginClaudeHookPairing(absent), /unpaired_post/);
  assert.deepEqual(next.pairingSnapshot(absent.key), { state: 'blocked', reasonCode: 'unpaired_post' });
  next.close();
});

test('legacy unpaired run is blocked, and explicit before failure stays blocked', t => {
  const k = new SqliteKernel(file(t)); t.after(() => k.close());
  const legacy = descriptor('legacy'); admit(k, legacy);
  assert.throws(() => k.beginClaudeHookPairing(legacy), /legacy_unpaired/);
  assert.deepEqual(k.pairingSnapshot(legacy.key), { state: 'blocked', reasonCode: 'legacy_unpaired' });
  assert.throws(() => k.beginClaudeHookPairing(legacy), /legacy_unpaired/);
  assert.deepEqual(k.pairingSnapshot(legacy.key), { state: 'blocked', reasonCode: 'legacy_unpaired' });
  const d = descriptor('failed'), receipt = k.beginClaudeHookPairing(d);
  k.blockClaudeHookPairing(receipt);
  k.blockClaudeHookPairing(receipt, 'outcome_conflict');
  assert.throws(() => k.beginClaudeHookPairing(d), /before_failed/);
  assert.deepEqual(k.pairingSnapshot(d.key), { state: 'blocked', reasonCode: 'before_failed' });
  assert.throws(() => k.blockClaudeHookPairing({ ...receipt, token: '00000000-0000-0000-0000-000000000000' }), /token/);
});

test('wrong receipt token, descriptor, and decision poison completion', t => {
  const k = new SqliteKernel(file(t)); t.after(() => k.close());
  for (const [name, mutate, reason] of [
    ['token', r => ({ ...r, token: '00000000-0000-0000-0000-000000000000' }), 'token_mismatch'],
    ['descriptor', r => ({ ...r, callDigest: digest('other-call') }), 'descriptor_mismatch'],
    ['decision', r => r, 'decision_mismatch'],
  ]) {
    const d = descriptor(name), receipt = k.beginClaudeHookPairing(d); admit(k, d);
    assert.throws(() => k.completeClaudeHookPairing(mutate(receipt), { decisionId: name === 'decision' ? 'wrong' : d.key }),
      new RegExp(reason));
    assert.deepEqual(k.pairingSnapshot(d.key), { state: 'blocked', reasonCode: reason });
    assert.throws(() => k.completeClaudeHookPairing(receipt, { decisionId: d.key }), new RegExp(reason));
  }
});

test('same post deduplicates; changed body blocks without rewriting original observation', t => {
  const k = new SqliteKernel(file(t)); t.after(() => k.close());
  const d = descriptor(); ready(k, d);
  k.observeClaudeHookPairing(d, observation);
  k.observeClaudeHookPairing(d, observation);
  assert.equal(k.inspect(d.key).observations.length, 1);
  assert.throws(() => k.observeClaudeHookPairing(d, { ...observation, status: 'failed' }), /outcome_conflict/);
  assert.deepEqual(k.pairingSnapshot(d.key), { state: 'blocked', reasonCode: 'outcome_conflict' });
  assert.deepEqual(k.inspect(d.key).observations, [observation]);
});

test('post descriptor mismatch blocks; invalid envelope is rejected before any state transition', t => {
  const k = new SqliteKernel(file(t)); t.after(() => k.close());
  const d = descriptor(); ready(k, d);
  assert.throws(() => k.observeClaudeHookPairing({ ...d, callDigest: 'not-a-hash' }, observation), /Invalid/);
  assert.throws(() => k.observeClaudeHookPairing(d, { ...observation, evidenceDigest: 'raw-secret' }), /Invalid/);
  assert.deepEqual(k.pairingSnapshot(d.key), { state: 'ready', reasonCode: null });
  assert.throws(() => k.observeClaudeHookPairing({ ...d, callDigest: digest('changed') }, observation), /descriptor_mismatch/);
  assert.deepEqual(k.pairingSnapshot(d.key), { state: 'blocked', reasonCode: 'descriptor_mismatch' });
  assert.deepEqual(k.inspect(d.key).observations, []);
});

test('action, deployment and request digests are checked against stored run at completion/post', t => {
  const path = file(t), k = new SqliteKernel(path);
  const wrongAction = descriptor('action');
  const a = k.beginClaudeHookPairing(wrongAction); admit(k, wrongAction, { actionDigest: digest('changed') });
  assert.throws(() => k.completeClaudeHookPairing(a, { decisionId: wrongAction.key }), /action_mismatch/);
  const wrongDeployment = descriptor('deployment');
  const b = k.beginClaudeHookPairing(wrongDeployment); admit(k, wrongDeployment, { mode: 'active' });
  assert.throws(() => k.completeClaudeHookPairing(b, { decisionId: wrongDeployment.key }), /deployment_mismatch/);
  const postAction = descriptor('post-action'); ready(k, postAction);
  const postDeployment = descriptor('post-deployment'); ready(k, postDeployment);
  const postRequest = descriptor('post-request'); ready(k, postRequest);
  k.close();
  sql(path, db => {
    db.prepare('UPDATE runs SET evidence=? WHERE key=?').run(JSON.stringify({ actionDigest: digest('tampered'),
      pack: { digest: deployment.packDigest }, binding: deployment.binding, mode: deployment.mode }), postAction.key);
    db.prepare('UPDATE runs SET evidence=? WHERE key=?').run(JSON.stringify({ actionDigest: postDeployment.actionDigest,
      pack: { digest: deployment.packDigest }, binding: deployment.binding, mode: 'changed' }), postDeployment.key);
    db.prepare('UPDATE runs SET request_digest=? WHERE key=?').run(digest('changed-request'), postRequest.key);
  });
  const next = new SqliteKernel(path); t.after(() => next.close());
  for (const [d, reason] of [[postAction, 'action_mismatch'], [postDeployment, 'deployment_mismatch'],
    [postRequest, 'request_mismatch']]) {
    assert.throws(() => next.observeClaudeHookPairing(d, observation), new RegExp(reason));
    assert.deepEqual(next.pairingSnapshot(d.key), { state: 'blocked', reasonCode: reason });
  }
});

const V1 = `
CREATE TABLE packs (id TEXT NOT NULL,version TEXT NOT NULL,digest TEXT NOT NULL,body TEXT NOT NULL,PRIMARY KEY(id,version)) STRICT;
CREATE TABLE runs (key TEXT PRIMARY KEY,request_digest TEXT NOT NULL,state TEXT NOT NULL CHECK(state IN ('admitted','executing','completed','unknown')),epoch INTEGER NOT NULL,owner TEXT NOT NULL,lease_until INTEGER NOT NULL,evidence TEXT NOT NULL,result TEXT) STRICT;
CREATE TABLE audit (seq INTEGER PRIMARY KEY,run_key TEXT NOT NULL REFERENCES runs(key),kind TEXT NOT NULL,details TEXT NOT NULL,at INTEGER NOT NULL) STRICT;
CREATE TABLE observations (run_key TEXT NOT NULL REFERENCES runs(key),id TEXT NOT NULL,body TEXT NOT NULL,PRIMARY KEY(run_key,id)) STRICT;
CREATE TABLE labels (run_key TEXT NOT NULL REFERENCES runs(key),id TEXT NOT NULL,body TEXT NOT NULL,PRIMARY KEY(run_key,id)) STRICT;`;
const V2 = `CREATE TABLE recovery_reviews (run_key TEXT NOT NULL REFERENCES runs(key),id TEXT NOT NULL,body TEXT NOT NULL,digest TEXT NOT NULL,applied_epoch INTEGER NOT NULL,at INTEGER NOT NULL,PRIMARY KEY(run_key,id),UNIQUE(run_key,applied_epoch)) STRICT;`;
for (const version of [1, 2]) test(`schema ${version} read-only stays unchanged; writable migration to 3 preserves evidence`, t => {
  const path = file(t);
  sql(path, db => {
    db.exec(V1 + (version === 2 ? V2 : '') + `PRAGMA user_version=${version};`);
    db.prepare('INSERT INTO runs VALUES(?,?,?,?,?,?,?,?)').run('legacy', digest('request'), 'completed', 1, 'old', 100,
      JSON.stringify({ pack: { digest: digest('pack') } }), '{}');
    db.prepare('INSERT INTO audit VALUES(1,?,?,?,?)').run('legacy', 'old', '{}', 1);
    db.prepare('INSERT INTO observations VALUES(?,?,?)').run('legacy', 'old', JSON.stringify(observation));
    db.prepare('INSERT INTO labels VALUES(?,?,?)').run('legacy', 'old', '{}');
  });
  const readOnly = new SqliteKernel(path, { readOnly: true });
  assert.equal(readOnly.pairingSnapshot('legacy'), null);
  assert.equal(readOnly.inspect('legacy').observations.length, 1);
  readOnly.close();
  sql(path, db => {
    assert.equal(db.prepare('PRAGMA user_version').get().user_version, version);
    assert.equal(db.prepare("SELECT count(*) n FROM sqlite_master WHERE name='claude_hook_pairs'").get().n, 0);
  });
  const migrated = new SqliteKernel(path);
  assert.equal(migrated.inspect('legacy').audit.length, 1);
  assert.equal(migrated.inspect('legacy').observations.length, 1);
  assert.equal(migrated.inspect('legacy').labels.length, 1);
  assert.equal(migrated.pairingSnapshot('legacy'), null);
  migrated.close();
  sql(path, db => assert.equal(db.prepare('PRAGMA user_version').get().user_version, 3));
});

for (const version of [1, 2]) test(`schema ${version} migration DDL failure rolls back entirely and can retry`, t => {
  const path = file(t);
  const original = sql(path, db => {
    db.exec(V1 + (version === 2 ? V2 : '') + `
      CREATE TABLE runs_recovery_scan (blocker TEXT) STRICT;
      PRAGMA user_version=${version};`);
    db.prepare('INSERT INTO packs VALUES(?,?,?,?)').run('old-pack', '1', digest('pack'), '{}');
    db.prepare('INSERT INTO runs VALUES(?,?,?,?,?,?,?,?)').run('legacy', digest('request'), 'completed', 1,
      'old-worker', 100, '{}', '{}');
    db.prepare('INSERT INTO audit VALUES(1,?,?,?,?)').run('legacy', 'old-event', '{}', 1);
    db.prepare('INSERT INTO observations VALUES(?,?,?)').run('legacy', 'old-outcome', JSON.stringify(observation));
    db.prepare('INSERT INTO labels VALUES(?,?,?)').run('legacy', 'old-label', '{}');
    if (version === 2) db.prepare('INSERT INTO recovery_reviews VALUES(?,?,?,?,?,?)')
      .run('legacy', 'old-review', '{}', digest('review'), 2, 2);
    return {
      schema: db.prepare("SELECT type,name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name").all(),
      packs: db.prepare('SELECT * FROM packs').all(), runs: db.prepare('SELECT * FROM runs').all(),
      audit: db.prepare('SELECT * FROM audit').all(), observations: db.prepare('SELECT * FROM observations').all(),
      labels: db.prepare('SELECT * FROM labels').all(),
      reviews: version === 2 ? db.prepare('SELECT * FROM recovery_reviews').all() : null,
    };
  });
  // The deliberately colliding table lets claude_hook_pairs be created first;
  // CREATE INDEX runs_recovery_scan then fails inside the same migration transaction.
  assert.throws(() => new SqliteKernel(path), /already a table named runs_recovery_scan/);
  sql(path, db => {
    assert.equal(db.prepare('PRAGMA user_version').get().user_version, version);
    assert.equal(db.prepare("SELECT count(*) n FROM sqlite_master WHERE name='claude_hook_pairs'").get().n, 0);
    assert.deepEqual(db.prepare("SELECT type,name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name").all(), original.schema);
    assert.deepEqual(db.prepare('SELECT * FROM packs').all(), original.packs);
    assert.deepEqual(db.prepare('SELECT * FROM runs').all(), original.runs);
    assert.deepEqual(db.prepare('SELECT * FROM audit').all(), original.audit);
    assert.deepEqual(db.prepare('SELECT * FROM observations').all(), original.observations);
    assert.deepEqual(db.prepare('SELECT * FROM labels').all(), original.labels);
    if (version === 2) assert.deepEqual(db.prepare('SELECT * FROM recovery_reviews').all(), original.reviews);
    else assert.equal(db.prepare("SELECT count(*) n FROM sqlite_master WHERE name='recovery_reviews'").get().n, 0);
    db.exec('DROP TABLE runs_recovery_scan');
  });
  const migrated = new SqliteKernel(path);
  assert.equal(migrated.inspect('legacy').audit.length, 1);
  assert.equal(migrated.inspect('legacy').observations.length, 1);
  assert.equal(migrated.inspect('legacy').labels.length, 1);
  assert.equal(migrated.pairingSnapshot('legacy'), null);
  migrated.close();
  sql(path, db => assert.equal(db.prepare('PRAGMA user_version').get().user_version, 3));
});

function worker(path, action) {
  return fork(pairingWorker, [path, action], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
}
const childEvent = (child, event) => once(child, event, { signal: AbortSignal.timeout(12000) });
async function stopWorker(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exit = childEvent(child, 'exit');
  child.kill();
  await exit;
}
test('independent OS processes race on one before; SQLite linearizes and poisons the key', { timeout: 15000 }, async t => {
  const path = file(t), init = new SqliteKernel(path); init.close();
  const a = worker(path, 'begin'), b = worker(path, 'begin');
  t.after(async () => { await Promise.all([stopWorker(a), stopWorker(b)]); });
  const readyA = childEvent(a, 'message'), readyB = childEvent(b, 'message');
  assert.deepEqual((await readyA)[0], { kind: 'ready' });
  assert.deepEqual((await readyB)[0], { kind: 'ready' });
  const replies = [childEvent(a, 'message'), childEvent(b, 'message')];
  const exits = [childEvent(a, 'exit'), childEvent(b, 'exit')];
  a.send('go'); b.send('go');
  const results = (await Promise.all(replies)).map(([message]) => message);
  assert.deepEqual(results.map(r => r.kind).sort(), ['ok', 'rejected']);
  assert.match(results.find(r => r.kind === 'rejected').message, /duplicate_pre/);
  await Promise.all(exits);
  const k = new SqliteKernel(path, { readOnly: true });
  assert.deepEqual(k.pairingSnapshot('process-race'), { state: 'blocked', reasonCode: 'duplicate_pre' });
  k.close();
});

test('process death after durable pending receipt does not admit later post', { timeout: 15000 }, async t => {
  const path = file(t), init = new SqliteKernel(path); init.close();
  const held = worker(path, 'hold'); t.after(async () => { await stopWorker(held); });
  const reserved = (await childEvent(held, 'message'))[0];
  assert.equal(reserved.kind, 'reserved');
  await stopWorker(held);
  const post = worker(path, 'post'); t.after(async () => { await stopWorker(post); });
  assert.deepEqual((await childEvent(post, 'message'))[0], { kind: 'ready' });
  const result = childEvent(post, 'message'), postExit = childEvent(post, 'exit'); post.send('go');
  assert.match((await result)[0].message, /early_post/);
  await postExit;
  const k = new SqliteKernel(path, { readOnly: true });
  assert.deepEqual(k.pairingSnapshot('process-race'), { state: 'blocked', reasonCode: 'early_post' });
  k.close();
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, rm, writeFile, access, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync, fork } from 'node:child_process';
import { once } from 'node:events';
import { MockProvider, toolPreflightPack } from '../dist/index.js';
import { SqliteKernel, digest } from '../adapters/sqlite-kernel.mjs';
import { DurableMesh, eventKey } from '../adapters/durable-mesh.mjs';
import { validateRecoveryReview, RECOVERY_RESOLUTIONS } from '../adapters/recovery-contract.mjs';
import { parseRecoveryOptions, readRecoveryFile } from '../adapters/recovery-cli.mjs';
import { event, result, requestOptions, readTool } from './helpers.mjs';

async function directory(t) {
  const dir = await mkdtemp(join(tmpdir(), 'reflexmesh-recovery-'));
  t.after(() => rm(dir, { recursive: true, force: true })); return dir;
}
function fixture(t, path = ':memory:') {
  let now = 0;
  const kernel = new SqliteKernel(path, { clock: () => now });
  t.after(() => kernel.close());
  return { kernel, tick: value => { now = value; } };
}
function admit(k, key = 'case-1', owner = 'worker') {
  return k.claim({ key, owner, requestDigest: digest({ key }), leaseMs: 100, evidence: { secret: 'DO_NOT_PRINT' } }).handle;
}
function unknown(k, key = 'case-1') { const h = admit(k, key); k.abandon(h); return h; }
function review(k, key = 'case-1', overrides = {}) {
  const r = k.recoverySnapshot(key);
  return { schemaVersion: 1, id: 'review-1', runKey: key, expectedEpoch: r.epoch, inputDigest: r.inputDigest,
    resolution: 'confirmed_succeeded', evidenceDigest: digest({ independent: 'fixture' }),
    evidenceRef: 'fixture:external-outcome', actorRef: 'operator:test', reason: 'Inspected independent fixture', quiescent: true, ...overrides };
}
function sql(path, fn) { const db = new DatabaseSync(path); try { return fn(db); } finally { db.close(); } }
function cli(args, inputEnv = {}) {
  return spawnSync(process.execPath, ['adapters/recovery-cli.mjs', ...args], {
    encoding: 'utf8', timeout: 5000, env: { PATH: process.env.PATH, ...inputEnv },
  });
}

// The operational schema before this change, used for real migration/read-only tests.
const V1 = `
CREATE TABLE packs (id TEXT NOT NULL,version TEXT NOT NULL,digest TEXT NOT NULL,body TEXT NOT NULL,PRIMARY KEY(id,version)) STRICT;
CREATE TABLE runs (key TEXT PRIMARY KEY,request_digest TEXT NOT NULL,state TEXT NOT NULL CHECK(state IN ('admitted','executing','completed','unknown')),epoch INTEGER NOT NULL,owner TEXT NOT NULL,lease_until INTEGER NOT NULL,evidence TEXT NOT NULL,result TEXT) STRICT;
CREATE TABLE audit (seq INTEGER PRIMARY KEY,run_key TEXT NOT NULL REFERENCES runs(key),kind TEXT NOT NULL,details TEXT NOT NULL,at INTEGER NOT NULL) STRICT;
CREATE TABLE observations (run_key TEXT NOT NULL REFERENCES runs(key),id TEXT NOT NULL,body TEXT NOT NULL,PRIMARY KEY(run_key,id)) STRICT;
CREATE TABLE labels (run_key TEXT NOT NULL REFERENCES runs(key),id TEXT NOT NULL,body TEXT NOT NULL,PRIMARY KEY(run_key,id)) STRICT;
PRAGMA user_version=1;`;
async function legacy(t) {
  const path = join(await directory(t), 'legacy.sqlite');
  sql(path, db => {
    db.exec(V1);
    db.prepare('INSERT INTO runs VALUES(?,?,?,?,?,?,?,?)').run('legacy', digest({ key: 'legacy' }), 'unknown', 2, 'old-worker', 1, '{}', null);
    db.prepare('INSERT INTO audit VALUES(1,?,?,?,?)').run('legacy', 'execution.unknown', '{}', 1);
    db.prepare('INSERT INTO observations VALUES(?,?,?)').run('legacy', 'o', '{"status":"unknown"}');
  });
  return path;
}

test('review envelope is frozen, bounded, and rejects extra raw evidence', t => {
  const { kernel: k } = fixture(t); unknown(k); const v = review(k);
  assert.ok(Object.isFrozen(validateRecoveryReview(v)));
  assert.throws(() => validateRecoveryReview({ ...v, rawOutput: 'SECRET' }), /fields/);
  assert.throws(() => validateRecoveryReview({ ...v, expectedEpoch: 1.5 }), /epoch/);
  assert.throws(() => validateRecoveryReview({ ...v, evidenceDigest: 'fake' }), /digest/);
  assert.throws(() => validateRecoveryReview({ ...v, actorRef: '\nunsafe' }), /provenance/);
  assert.throws(() => validateRecoveryReview({ ...v, reason: 'x'.repeat(513) }), /provenance/);
  assert.throws(() => validateRecoveryReview({ ...v, resolution: 'retry' }), /resolution/);
  assert.throws(() => validateRecoveryReview({ ...v, quiescent: false }), /quiescence/);
  let touched = 0;
  assert.throws(() => validateRecoveryReview({ ...v, get reason() { touched++; return 'x'; } }), /accessor/);
  assert.equal(touched, 0);
});
for (const resolution of RECOVERY_RESOLUTIONS) test(`operator ${resolution} never unblocks or replays the action`, t => {
  const { kernel: k, tick } = fixture(t); unknown(k); tick(101);
  const v = review(k, 'case-1', { resolution });
  const before = k.inspect('case-1'); const preview = k.previewRecovery(v);
  assert.equal(preview.wouldRecord, true); assert.deepEqual(k.inspect('case-1'), before);
  const r = k.reviewRecovery(v); assert.equal(r.executionAllowed, false); assert.equal(r.state, 'unknown');
  assert.equal(k.inspect('case-1').epoch, v.expectedEpoch + 1);
  assert.equal(k.inspect('case-1').result, before.result); assert.deepEqual(k.inspect('case-1').labels, []);
  assert.equal(k.claim({ key: 'case-1', requestDigest: v.inputDigest, owner: 'new', leaseMs: 100, evidence: {} }).kind, 'unknown');
});
test('read-only inspection of schema 1 does not migrate it', async t => {
  const path = await legacy(t), k = new SqliteKernel(path, { readOnly: true }); t.after(() => k.close());
  assert.equal(k.recoverySnapshot('legacy').latestReview, null); assert.equal(k.listRecoveries().items.length, 1);
  assert.equal(k.previewRecovery(review(k, 'legacy')).wouldRecord, true);
  sql(path, db => {
    assert.equal(db.prepare('PRAGMA user_version').get().user_version, 1);
    assert.equal(db.prepare("SELECT count(*) n FROM sqlite_master WHERE name='recovery_reviews'").get().n, 0);
  });
  assert.throws(() => k.reviewRecovery(review(k, 'legacy')), /Read-only/);
  assert.throws(() => k.registerPack(toolPreflightPack), /Read-only/);
  assert.throws(() => admit(k), /Read-only/);
});
test('schema 1 to 2 migration preserves previous journal and outcomes', async t => {
  const path = await legacy(t), k = new SqliteKernel(path); t.after(() => k.close());
  assert.equal(k.inspect('legacy').audit.length, 1); assert.equal(k.inspect('legacy').observations.length, 1);
  assert.equal(k.reviewRecovery(review(k, 'legacy')).recorded, true);
  sql(path, db => assert.equal(db.prepare('PRAGMA user_version').get().user_version, 2));
  const viewer = new SqliteKernel(path, { readOnly: true }); t.after(() => viewer.close());
  assert.equal(viewer.recoverySnapshot('legacy').latestReview.review.actorRef, 'operator:test');
});
test('unsupported future schema fails without changing version', async t => {
  const path = join(await directory(t), 'future.sqlite'); sql(path, db => db.exec('PRAGMA user_version=777'));
  for (const readOnly of [true,false]) assert.throws(() => new SqliteKernel(path, { readOnly }), /Unsupported/);
  sql(path, db => assert.equal(db.prepare('PRAGMA user_version').get().user_version, 777));
});
test('read-only opening a missing database fails without creating a file', async t => {
  const path = join(await directory(t), 'missing.sqlite');
  assert.throws(() => new SqliteKernel(path, { readOnly: true })); await assert.rejects(access(path));
  const r = cli(['list','--db',path]); assert.notEqual(r.status, 0); await assert.rejects(access(path));
});
test('recovery list has stable bounded keyset pagination and excludes raw evidence', t => {
  const { kernel: k, tick } = fixture(t);
  for (let i = 0; i < 105; i++) unknown(k, `k${String(i).padStart(3,'0')}`);
  tick(101); const a = k.listRecoveries({ limit: 100 }), b = k.listRecoveries({ limit: 100, after: a.nextCursor });
  assert.equal(a.items.length, 100); assert.equal(b.items.length, 5); assert.equal(b.nextCursor, null);
  assert.equal(new Set([...a.items,...b.items].map(x => x.key)).size, 105);
  assert.ok(!JSON.stringify(a).includes('DO_NOT_PRINT'));
  for (const limit of [0,101,NaN,2.5]) assert.throws(() => k.listRecoveries({ limit }), /page/);
});
test('recovery queue separates expired executing, unknown and live/admitted states', t => {
  const { kernel: k, tick } = fixture(t);
  const h = admit(k, 'executing'); k.append(h, { kind: 'action.started', details: {} });
  admit(k, 'admitted'); unknown(k, 'unknown');
  assert.deepEqual(k.listRecoveries().items.map(r => r.key), ['unknown']);
  tick(101); assert.deepEqual(k.listRecoveries().items.map(r => r.key), ['executing','unknown']);
});
test('reviewed queue items are hidden unless included; unresolved stays visible', t => {
  const { kernel: k, tick } = fixture(t); unknown(k); tick(101);
  k.reviewRecovery(review(k, 'case-1', { resolution: 'unresolved' })); assert.equal(k.listRecoveries().items.length, 1);
  k.reviewRecovery(review(k, 'case-1', { id: 'review-2', resolution: 'confirmed_failed' }));
  assert.equal(k.listRecoveries().items.length, 0); assert.equal(k.listRecoveries({ includeReviewed: true }).items.length, 1);
});
test('live leases cannot be reviewed even with a quiescence declaration', t => {
  const { kernel: k } = fixture(t); const h = admit(k); k.append(h, { kind: 'action.started', details: {} });
  assert.throws(() => k.reviewRecovery(review(k)), /still live/);
  k.abandon(h); assert.throws(() => k.reviewRecovery(review(k)), /still live/);
});
test('completed and unstarted admitted runs cannot be marked by recovery review', t => {
  const { kernel: k, tick } = fixture(t); const h = admit(k);
  k.complete(h, { status: 'shadow', verdict: { effect: 'escalate', ruleId: 'fixture' } });
  admit(k, 'unstarted'); tick(101);
  for (const key of ['case-1','unstarted']) assert.throws(() => k.reviewRecovery(review(k,key)), /not awaiting/);
});
test('review rejects stale epoch, wrong input digest and missing run', t => {
  const { kernel: k, tick } = fixture(t); unknown(k); tick(101);
  assert.throws(() => k.reviewRecovery(review(k, 'case-1', { expectedEpoch: 1 })), /epoch conflict/);
  assert.throws(() => k.reviewRecovery(review(k, 'case-1', { inputDigest: 'f'.repeat(64) })), /digest conflict/);
  assert.throws(() => k.reviewRecovery(review(k, 'case-1', { runKey: 'missing' })), /Unknown recovery/);
});
test('identical review IDs are idempotent; changed payload conflicts', t => {
  const { kernel: k, tick } = fixture(t); unknown(k); tick(101); const v = review(k);
  const first = k.reviewRecovery(v), before = k.inspect('case-1');
  assert.equal(k.reviewRecovery(v).replayed, true); assert.deepEqual(k.inspect('case-1'), before);
  assert.equal(k.previewRecovery(v).wouldRecord, false);
  assert.throws(() => k.reviewRecovery({ ...v, reason: 'different' }), /ID conflict/);
  k.reviewRecovery(review(k, 'case-1', { id: 'new-review' }));
  assert.equal(k.reviewRecovery(v).appliedEpoch, first.appliedEpoch); // Original receipt, not a claim about the current epoch.
});
test('expired executing review fences old journal writer without creating success', t => {
  const { kernel: k, tick } = fixture(t); const h = admit(k); k.append(h, { kind: 'action.started', details: {} }); tick(101);
  k.reviewRecovery(review(k));
  assert.throws(() => k.complete(h, { status: 'succeeded' }), /fenced/);
  assert.throws(() => k.append(h, { kind: 'outcome', details: {} }), /fenced/);
  assert.equal(k.inspect('case-1').state, 'unknown'); assert.equal(k.inspect('case-1').result, null);
});
test('audit failure atomically rolls back review, state transition and epoch', async t => {
  const path = join(await directory(t), 'state.sqlite'), { kernel: k, tick } = fixture(t, path);
  const h = admit(k); k.append(h, { kind: 'action.started', details: {} }); tick(101);
  sql(path, db => db.exec("CREATE TRIGGER review_audit_fail BEFORE INSERT ON audit WHEN NEW.kind='recovery.reviewed' BEGIN SELECT RAISE(ABORT,'injected failure'); END"));
  const before = k.inspect('case-1'); assert.throws(() => k.reviewRecovery(review(k)), /injected/);
  assert.deepEqual(k.inspect('case-1'), before);
  sql(path, db => assert.equal(db.prepare('SELECT count(*) n FROM recovery_reviews').get().n, 0));
});
test('independent connection rejects stale reviewer after another accepts', async t => {
  const path = join(await directory(t), 'state.sqlite'), { kernel: a, tick } = fixture(t, path); unknown(a); tick(101);
  const b = new SqliteKernel(path, { clock: () => 101 }); t.after(() => b.close());
  const old = review(b); a.reviewRecovery(review(a));
  assert.throws(() => b.reviewRecovery({ ...old, id: 'second-operator' }), /epoch conflict/);
  assert.equal(b.recoverySnapshot('case-1').epoch, 3);
});
test('late/duplicate DurableMesh calls remain blocked after confirmed_not_executed review and reopen', async t => {
  const path = join(await directory(t), 'state.sqlite'); let now = 0, calls = 0;
  let k = new SqliteKernel(path, { clock: () => now });
  const binding = { providerId: 'mock', modelId: 'fixture', revision: 'v1', authorizationRevision: 'v1', toolsetRevision: 'v1' };
  const setup = store => new DurableMesh({ kernel: store, provider: new MockProvider(result), binding, mode: 'active', authorize: () => true, actionTimeoutMs: 10, leaseMs: 100 })
    .registerPack(toolPreflightPack).registerTool(readTool(() => { calls++; return new Promise(() => {}); }));
  const e = event(), o = requestOptions(); assert.equal((await setup(k).run(e,o)).status, 'recovery_required'); now = 101;
  const v = review(k, eventKey(e), { resolution: 'confirmed_not_executed' }); k.reviewRecovery(v); k.close();
  k = new SqliteKernel(path); t.after(() => k.close());
  assert.equal((await setup(k).run(e,o)).status, 'recovery_required'); assert.equal(calls, 1);
  const changed = requestOptions(); changed.action.args = { different: true };
  await assert.rejects(setup(k).run(e,changed), /Idempotency conflict/);
});
test('real CLI preview performs no logical writes; explicit apply persists metadata only', async t => {
  const dir = await directory(t), path = join(dir, 'state.sqlite'), f = join(dir, 'review.json');
  const { kernel: k } = fixture(t, path); unknown(k); const v = review(k); await writeFile(f, JSON.stringify(v));
  const before = k.inspect('case-1');
  let r = cli(['review','--db',path,'--file',f]); assert.equal(r.status, 0, r.stderr); assert.equal(JSON.parse(r.stdout).mode, 'preview'); assert.deepEqual(k.inspect('case-1'), before);
  r = cli(['review','--db',path,'--file',f,'--apply']); assert.equal(r.status, 0, r.stderr); assert.equal(JSON.parse(r.stdout).executionAllowed, false);
  r = cli(['inspect','--db',path,'--key','case-1']); assert.equal(r.status, 0); assert.equal(JSON.parse(r.stdout).latestReview.review.id, 'review-1');
  assert.ok(!r.stdout.includes('DO_NOT_PRINT'));
  r = cli(['list','--db',path]); assert.deepEqual(JSON.parse(r.stdout).items, []);
  r = cli(['list','--db',path,'--include-reviewed']); assert.equal(JSON.parse(r.stdout).items.length, 1);
});
test('CLI preview of old schema does not upgrade; apply upgrades after explicit selection', async t => {
  const path = await legacy(t), f = `${path}.review.json`;
  const k = new SqliteKernel(path, { readOnly: true }); await writeFile(f, JSON.stringify(review(k, 'legacy'))); k.close();
  const p = cli(['review','--db',path,'--file',f]); assert.equal(p.status, 0, p.stderr);
  sql(path, db => assert.equal(db.prepare('PRAGMA user_version').get().user_version, 1));
  const a = cli(['review','--db',path,'--file',f,'--apply']); assert.equal(a.status, 0, a.stderr);
  sql(path, db => assert.equal(db.prepare('PRAGMA user_version').get().user_version, 2));
});
test('CLI refuses force/reset options, duplicate flags and invalid limits', () => {
  for (const args of [[], ['list'], ['list','--db','x','--apply'], ['review','--db','x','--file','v','--force'], ['list','--db','x','--db','y'], ['list','--db','x','--limit','101'], ['list','--db','x','--limit','1.5']]) assert.throws(() => parseRecoveryOptions(args));
  assert.equal(parseRecoveryOptions(['review','--db','x','--file','r']).apply, undefined);
  assert.equal(cli(['--help']).status, 0);
});
test('CLI invalid review JSON never prints secret payload or updates the journal', async t => {
  const dir = await directory(t), path = join(dir, 'state.sqlite'), f = join(dir, 'bad.json');
  const { kernel: k } = fixture(t, path); unknown(k); const before = k.inspect('case-1');
  for (const bytes of [Buffer.from('SECRET:not-json'), Buffer.alloc(20000, 65), Buffer.from([0xff,0xfe])]) {
    await writeFile(f, bytes); const r = cli(['review','--db',path,'--file',f,'--apply']);
    assert.notEqual(r.status, 0); assert.ok(!r.stderr.includes('SECRET')); assert.deepEqual(k.inspect('case-1'), before);
  }
  await assert.rejects(readRecoveryFile(dir), /regular file/);
});
test('two actual OS processes cannot accept conflicting reviews at the same epoch', { timeout: 10000 }, async t => {
  const dir = await directory(t), path = join(dir, 'state.sqlite'), f = join(dir, 'review.json');
  const { kernel: k } = fixture(t, path); unknown(k); await writeFile(f, JSON.stringify(review(k)));
  const children = ['first','second'].map(id => fork(new URL('./fixtures/review-racer.mjs', import.meta.url), [path,f,id], { stdio: ['ignore','ignore','ignore','ipc'] }));
  t.after(() => children.forEach(c => { if (c.exitCode === null) c.kill('SIGKILL'); }));
  await Promise.all(children.map(c => once(c,'message')));
  const replies = children.map(c => once(c,'message')); children.forEach(c => c.send('go'));
  const statuses = (await Promise.all(replies)).map(([r]) => r.status).sort();
  assert.deepEqual(statuses, ['accepted','conflict']);
  sql(path, db => assert.equal(db.prepare('SELECT count(*) n FROM recovery_reviews').get().n, 1));
});

test('review input refuses symlinks and non-regular files without following them', { skip: process.platform === 'win32' }, async t => {
  const dir = await directory(t), target = join(dir, 'target.json'), link = join(dir, 'link.json'), fifo = join(dir, 'input.fifo');
  await writeFile(target, '{}'); await symlink(target, link);
  await assert.rejects(readRecoveryFile(link), /regular file/);
  const mk = spawnSync('mkfifo', [fifo]); assert.equal(mk.status, 0);
  const r = cli(['review', '--db', join(dir, 'missing.sqlite'), '--file', fifo]);
  assert.notEqual(r.status, 0);
  await assert.rejects(readRecoveryFile(fifo), /regular file/);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { MockProvider, toolPreflightPack } from '../dist/index.js';
import { SqliteKernel, digest } from '../adapters/sqlite-kernel.mjs';
import { DurableMesh, eventKey, replayPolicy } from '../adapters/durable-mesh.mjs';
import { event, result, requestOptions, readTool } from './helpers.mjs';

const binding = { providerId: 'mock', modelId: 'fixture', revision: 'fixture-v1', authorizationRevision: 'test-v1', toolsetRevision: 'test-v1', calibrationRef: null };
const setup = (kernel, opts = {}) => new DurableMesh({ kernel, provider: new MockProvider(result), binding, ...opts }).registerPack(toolPreflightPack);
const disk = async t => { const dir = await mkdtemp(join(tmpdir(), 'reflexmesh-kernel-')); t.after(() => rm(dir, { recursive: true, force: true })); return join(dir, 'kernel.sqlite'); };
const claim = (kernel, overrides = {}) => kernel.claim({ key: 'key', requestDigest: 'digest', owner: 'one', leaseMs: 100, evidence: {}, ...overrides });

test('SQLite decision survives close/reopen, no second provider call, no raw state', async t => {
  const path = await disk(t); let calls = 0;
  let kernel = new SqliteKernel(path);
  const e = event({ state: { secret: 'DO_NOT_PERSIST' } });
  await setup(kernel, { provider: new MockProvider(() => { calls++; return result(); }) }).run(e, requestOptions());
  const metadata = kernel.inspect(eventKey(e)); assert.ok(!JSON.stringify(metadata).includes('DO_NOT_PERSIST'));
  kernel.close(); kernel = new SqliteKernel(path);
  const replay = await setup(kernel, { provider: new MockProvider(() => { calls++; return result(); }) }).run({ ...e, time: new Date().toISOString() }, requestOptions());
  assert.equal(replay.replayed, true); assert.equal(calls, 1); kernel.close();
});
test('two independent connections admit one logical action', async t => {
  const path = await disk(t), a = new SqliteKernel(path), b = new SqliteKernel(path);
  let actions = 0, release; const barrier = new Promise(r => { release = r; });
  const one = setup(a, { mode: 'active', authorize: () => true, provider: new MockProvider(async () => { await barrier; return result(); }) }).registerTool(readTool(async () => { actions++; return { private: 'VALUE_NOT_RETAINED' }; }));
  const two = setup(b, { mode: 'active', authorize: () => true }).registerTool(readTool(async () => { actions++; return {}; }));
  const e = event(), o = requestOptions(), first = one.run(e, o);
  assert.equal((await two.run(e, o)).status, 'in_flight'); release();
  assert.equal((await first).status, 'succeeded');
  const again = await two.run(e, o); assert.equal(again.replayed, true); assert.equal(again.output, undefined); assert.equal(actions, 1);
  assert.ok(!JSON.stringify(a.inspect(eventKey(e))).includes('VALUE_NOT_RETAINED')); a.close(); b.close();
});
test('concurrent duplicates coalesce within the same durable wrapper', async () => {
  const k = new SqliteKernel(':memory:'); let calls = 0;
  const m = setup(k, { provider: new MockProvider(() => { calls++; return result(); }) }); const e = event();
  const runs = await Promise.all(Array.from({ length: 12 }, () => m.run(e, requestOptions())));
  assert.equal(calls, 1); assert.ok(runs.every(r => r === runs[0])); k.close();
});
test('pack version cannot be changed across processes/restarts', async t => {
  const p = await disk(t); let k = new SqliteKernel(p); setup(k); k.close(); k = new SqliteKernel(p);
  const pack = structuredClone(toolPreflightPack); pack.rules[0].all[0].value = 0.8;
  assert.throws(() => k.registerPack(pack), /immutable/); pack.version = '0.2.0'; assert.equal(k.registerPack(pack), digest(pack)); k.close();
});
test('changed arguments, provider binding, authorization revision and mode conflict', async () => {
  const k = new SqliteKernel(':memory:'), e = event(); await setup(k).run(e, requestOptions());
  const o = requestOptions(); o.action.args = { changed: true };
  await assert.rejects(setup(k).run(e, o), /Idempotency conflict/);
  await assert.rejects(setup(k, { binding: { ...binding, revision: 'v2' } }).run(e, requestOptions()), /Idempotency conflict/);
  await assert.rejects(setup(k, { binding: { ...binding, authorizationRevision: 'v2' } }).run(e, requestOptions()), /Idempotency conflict/);
  await assert.rejects(setup(k, { mode: 'active' }).run(e, requestOptions()), /Idempotency conflict/); k.close();
});
test('unexpected returned model fails closed and does not fabricate calibration', async () => {
  const k = new SqliteKernel(':memory:');
  const m = setup(k, { provider: new MockProvider(() => ({ ...result(), model: 'silently-upgraded' })) });
  const r = await m.run(event(), requestOptions()); assert.equal(r.verdict.effect, 'escalate'); assert.equal(r.provider, undefined); k.close();
});
test('expired pre-execution admission is reclaimable and stale owner is fenced', () => {
  let now = 0; const k = new SqliteKernel(':memory:', { clock: () => now });
  const first = claim(k); now = 101; const second = claim(k, { owner: 'two' });
  assert.equal(second.handle.epoch, 2);
  assert.throws(() => k.append(first.handle, { kind: 'action.started', details: {} }), /fenced/);
  k.append(second.handle, { kind: 'action.started', details: {} }); assert.equal(k.inspect('key').state, 'executing'); k.close();
});
test('expired executing admission becomes UNKNOWN, never reclaimed', () => {
  let now = 0; const k = new SqliteKernel(':memory:', { clock: () => now });
  const first = claim(k); k.append(first.handle, { kind: 'action.started', details: {} }); now = 101;
  assert.equal(claim(k, { owner: 'two' }).kind, 'unknown');
  assert.throws(() => k.complete(first.handle, { status: 'succeeded' }), /fenced/);
  assert.equal(claim(k, { owner: 'three' }).kind, 'unknown'); k.close();
});
test('tool deadline remains UNKNOWN after restart; no blind retry', async t => {
  const path = await disk(t); let k = new SqliteKernel(path), actions = 0;
  const e = event(), o = requestOptions();
  const m = setup(k, { mode: 'active', authorize: () => true, actionTimeoutMs: 10 }).registerTool(readTool(() => { actions++; return new Promise(() => {}); }));
  assert.equal((await m.run(e, o)).status, 'recovery_required'); k.close(); k = new SqliteKernel(path);
  const next = setup(k, { mode: 'active', authorize: () => true, actionTimeoutMs: 10 }).registerTool(readTool(async () => { actions++; return {}; }));
  assert.equal((await next.run(e, o)).status, 'recovery_required'); assert.equal(actions, 1); k.close();
});
test('before-action audit failure prevents execution and retains a tombstone', async () => {
  const k = new SqliteKernel(':memory:'); const append = k.append.bind(k); let actions = 0;
  k.append = (h, r) => { if (r.kind === 'action.started') throw new Error('disk_full'); return append(h, r); };
  const e = event(), m = setup(k, { mode: 'active', authorize: () => true }).registerTool(readTool(async () => { actions++; return {}; }));
  await assert.rejects(m.run(e, requestOptions()), /disk_full/); assert.equal(actions, 0); assert.equal(k.inspect(eventKey(e)).state, 'unknown'); k.close();
});
test('after-action settle failure never causes reexecution', async () => {
  const k = new SqliteKernel(':memory:'); k.complete = () => { throw new Error('disk_full'); }; let calls = 0;
  const m = setup(k, { mode: 'active', authorize: () => true }).registerTool(readTool(async () => { calls++; return {}; }));
  const e = event(); await assert.rejects(m.run(e, requestOptions()), /disk_full/);
  assert.equal((await m.run(e, requestOptions())).status, 'recovery_required'); assert.equal(calls, 1); k.close();
});
test('labels remain separate from observed successful outcomes', async () => {
  const k = new SqliteKernel(':memory:'), e = event(); await setup(k).run(e, requestOptions()); const key = eventKey(e);
  const obs = { id: 'outcome', status: 'succeeded', provenance: 'model-reported', evidenceDigest: digest({ ok: true }) };
  k.observe(key, obs); k.observe(key, obs); assert.equal(k.inspect(key).observations.length, 1); assert.deepEqual(k.inspect(key).labels, []);
  assert.throws(() => k.observe(key, { ...obs, status: 'failed' }), /conflict/);
  assert.throws(() => k.addLabel(key, { id: 'label', questionId: 'intentMatch', value: 1, sourceRef: 'fake', provenance: 'model-reported' }), /provenance/);
  k.addLabel(key, { id: 'label', questionId: 'intentMatch', value: 1, sourceRef: 'fixture:case-1', provenance: 'test-oracle' });
  assert.equal(k.inspect(key).labels.length, 1); k.close();
});
test('policy replay cannot invoke tools and rejects changed questions', async () => {
  const k = new SqliteKernel(':memory:'), e = event(); await setup(k).run(e, requestOptions());
  const candidate = structuredClone(toolPreflightPack); candidate.version = 'candidate'; candidate.rules[2].all[0].value = 1;
  const r = replayPolicy(k.inspect(eventKey(e)), candidate); assert.equal(r.hypothetical, true); assert.equal(r.executionAllowed, false);
  assert.equal(r.original.effect, 'allow'); assert.equal(r.candidate.effect, 'escalate');
  candidate.questions.intentMatch.instructions = 'A different question'; assert.throws(() => replayPolicy(k.inspect(eventKey(e)), candidate), /contract mismatch/); k.close();
});
test('store rejects orphan outcomes', () => {
  const k = new SqliteKernel(':memory:');
  assert.throws(() => k.observe('missing', { id: 'o', status: 'unknown', provenance: 'harness-reported', evidenceDigest: digest({}) }), /Orphan/); k.close();
});

for (const stage of ['admitted','executing']) test(`real process kill after ${stage} preserves admission safety`, { timeout: 7000 }, async t => {
  const path = await disk(t), marker = `${path}.effects`;
  const child = fork(new URL('./fixtures/durable-worker.mjs', import.meta.url), [path, marker, stage], { stdio: ['ignore','ignore','ignore','ipc'] });
  t.after(() => { if (child.exitCode === null) child.kill('SIGKILL'); });
  await Promise.race([once(child, 'message'), once(child, 'exit').then(() => { throw new Error('Worker exited early'); })]);
  child.kill('SIGKILL'); await once(child, 'exit'); await new Promise(r => setTimeout(r, 130));
  const k = new SqliteKernel(path); let calls = 0;
  const m = setup(k, { mode: 'active', authorize: () => true, leaseMs: 100 }).registerTool(readTool(async () => { calls++; return {}; }));
  const r = await m.run(event({ id: 'crash-case' }), requestOptions());
  if (stage === 'admitted') { assert.equal(r.status, 'succeeded'); assert.equal(calls, 1); }
  else { assert.equal(r.status, 'recovery_required'); assert.equal(calls, 0); assert.equal((await readFile(marker, 'utf8')).trim(), 'one-effect'); }
  k.close();
});

test('simultaneous separate OS processes obtain only one admission', { timeout: 10000 }, async t => {
  const path = await disk(t);
  const children = Array.from({ length: 2 }, () => fork(new URL('./fixtures/admission-racer.mjs', import.meta.url), [path], { stdio: ['ignore','ignore','ignore','ipc'] }));
  t.after(() => children.forEach(c => { if (c.exitCode === null) c.kill('SIGKILL'); }));
  await Promise.all(children.map(c => once(c, 'message')));
  const replies = children.map(c => once(c, 'message')), exits = children.map(c => once(c, 'exit'));
  children.forEach(c => c.send('go'));
  const kinds = (await Promise.all(replies)).map(([r]) => r.kind).sort(); assert.deepEqual(kinds, ['busy','claimed']);
  await Promise.all(exits);
});
test('unknown SQLite schema is rejected rather than silently migrated', async t => {
  const { DatabaseSync } = await import('node:sqlite');
  const path = await disk(t), db = new DatabaseSync(path); db.exec('PRAGMA user_version=999'); db.close();
  assert.throws(() => new SqliteKernel(path), /Unsupported kernel schema/);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { MockProvider, MemoryLedger, ReflexMesh, toolPreflightPack } from '../dist/index.js';
import { event, result, requestOptions, harness, readTool } from './helpers.mjs';

test('shadow is default and never calls the tool', async () => {
  let calls = 0; const { mesh } = harness(); mesh.registerTool(readTool(async () => { calls++; return {}; }));
  const r = await mesh.run(event(), requestOptions());
  assert.equal(r.status, 'shadow'); assert.equal(calls, 0); assert.equal(r.verdict.effect, 'allow');
});
test('active mode requires explicit host authorization', async () => {
  const { mesh } = harness({ mode: 'active' }); mesh.registerTool(readTool());
  assert.equal((await mesh.run(event(), requestOptions())).reasonCode, 'authorization_required');
});
test('host-authorized registered read succeeds', async () => {
  const { mesh } = harness({ mode: 'active', authorize: () => true }); mesh.registerTool(readTool());
  const r = await mesh.run(event(), requestOptions()); assert.equal(r.status, 'succeeded'); assert.deepEqual(r.output, { ok: true });
});
test('write capabilities cannot be supplied by untrusted event state', async () => {
  let calls = 0; const { mesh } = harness({ mode: 'active', authorize: () => true });
  mesh.registerTool(readTool(async () => { calls++; return {}; }, { effect: 'write' }));
  const r = await mesh.run(event({ state: { safe: true, effect: 'read', authorized: true } }), requestOptions());
  assert.equal(r.reasonCode, 'write_confirmation_not_implemented'); assert.equal(calls, 0);
});
test('unregistered tool is blocked', async () => {
  const { mesh } = harness({ mode: 'active', authorize: () => true });
  assert.equal((await mesh.run(event(), requestOptions())).reasonCode, 'unregistered_tool');
});
test('tenant mismatch blocks execution', async () => {
  const { mesh } = harness({ mode: 'active', authorize: () => true }); mesh.registerTool(readTool());
  const options = requestOptions(); options.principal.tenantId = 'other';
  assert.equal((await mesh.run(event(), options)).reasonCode, 'authorization_required');
});
test('truthy authorization values are not permission', async () => {
  const { mesh } = harness({ mode: 'active', authorize: () => 'yes' }); mesh.registerTool(readTool());
  assert.equal((await mesh.run(event(), requestOptions())).reasonCode, 'authorization_denied');
});
test('concurrent duplicate events invoke provider and tool once', async () => {
  let decisions = 0, actions = 0;
  const { mesh } = harness({ mode: 'active', authorize: () => true, provider: new MockProvider(async () => { decisions++; await new Promise(r => setTimeout(r, 5)); return result(); }) });
  mesh.registerTool(readTool(async () => { actions++; return {}; }));
  const e = event(), o = requestOptions(); const runs = await Promise.all(Array.from({ length: 20 }, () => mesh.run(e, o)));
  assert.equal(decisions, 1); assert.equal(actions, 1); assert.ok(runs.every(r => r === runs[0]));
});
test('same id with changed arguments raises idempotency conflict', async () => {
  const { mesh } = harness(); const e = event(), o = requestOptions(); await mesh.run(e, o);
  await assert.rejects(mesh.run(e, { ...o, action: { toolId: 'read', args: { changed: true } } }), /Idempotency conflict/);
});
test('idempotency is scoped by tenant and source', async () => {
  let calls = 0; const { mesh } = harness({ provider: new MockProvider(() => { calls++; return result(); }) });
  const e = event(); await mesh.run(e, requestOptions()); await mesh.run({ ...e, tenantId: 't2' }, requestOptions()); await mesh.run({ ...e, source: 'different' }, requestOptions());
  assert.equal(calls, 3);
});
test('capacity causes backpressure instead of evicting action tombstones', async () => {
  const { mesh } = harness({ maxRetainedEvents: 1 }); await mesh.run(event(), requestOptions());
  await assert.rejects(mesh.run(event(), requestOptions()), /capacity/);
});
test('provider failure escalates without copying secrets into audit', async () => {
  const { mesh, ledger } = harness({ mode: 'active', provider: new MockProvider(() => { throw new Error('SECRET'); }) });
  const r = await mesh.run(event({ state: { password: 'SECRET' } }), requestOptions());
  assert.equal(r.status, 'blocked'); assert.equal(r.verdict.effect, 'escalate'); assert.ok(!JSON.stringify(ledger.list()).includes('SECRET'));
});
test('invalid provider probabilities fail closed', async () => {
  const bad = result(); bad.answers.intentMatch.noul = NaN;
  const { mesh } = harness({ mode: 'active', provider: new MockProvider(() => bad) });
  assert.equal((await mesh.run(event(), requestOptions())).verdict.effect, 'escalate');
});
test('uncooperative provider is bounded by a runtime deadline', async () => {
  const { mesh } = harness({ mode: 'active', decisionTimeoutMs: 15,
    provider: { id: 'hung', capabilities: new MockProvider(result).capabilities,
      evaluate: () => new Promise(() => {}) } });
  const r = await mesh.run(event(), requestOptions()); assert.equal(r.status, 'blocked');
});
test('tool timeout is unknown outcome and is not automatically retried', async () => {
  let calls = 0; const { mesh } = harness({ mode: 'active', authorize: () => true, actionTimeoutMs: 15 });
  mesh.registerTool(readTool(() => { calls++; return new Promise(() => {}); }));
  const e = event(), o = requestOptions(); const r = await mesh.run(e, o); await mesh.run(e, o);
  assert.equal(r.status, 'recovery_required'); assert.equal(calls, 1);
});
test('audit failure before action prevents execution', async () => {
  let calls = 0; const { mesh } = harness({ mode: 'active', authorize: () => true, ledger: { append: async () => { throw new Error('sink down'); } } });
  mesh.registerTool(readTool(async () => { calls++; return {}; }));
  await assert.rejects(mesh.run(event(), requestOptions()), /sink down/); assert.equal(calls, 0);
});
test('audit failure after action keeps failed promise as a tombstone', async () => {
  let calls = 0; const { mesh } = harness({ mode: 'active', authorize: () => true, ledger: { append: async row => { if (row.kind === 'outcome') throw new Error('disk full'); } } });
  mesh.registerTool(readTool(async () => { calls++; return {}; }));
  const e = event(), o = requestOptions(); await assert.rejects(mesh.run(e, o), /disk full/); await assert.rejects(mesh.run(e, o), /disk full/); assert.equal(calls, 1);
});
test('registered pack snapshot cannot be changed by its caller', async () => {
  const pack = structuredClone(toolPreflightPack);
  const mesh = new ReflexMesh({ provider: new MockProvider(result), ledger: new MemoryLedger() }).registerPack(pack);
  pack.rules[2].effect = 'deny'; assert.equal((await mesh.run(event(), requestOptions())).verdict.effect, 'allow');
});
test('audit snapshots cannot be mutated through list()', async () => {
  const { mesh, ledger } = harness(); await mesh.run(event(), requestOptions());
  assert.throws(() => { ledger.list()[0].details.pack = 'tampered'; }, TypeError);
});
test('provider assesses actual requested args, not just claimed event args', async () => {
  let seen;
  const { mesh } = harness({ provider: new MockProvider(state => { seen = state; return result(); }) });
  const o = requestOptions(); o.action.args = { actual: 'README.md' };
  await mesh.run(event({ state: { proposedAction: 'fake' } }), o);
  assert.deepEqual(seen.proposedAction.args, o.action.args); assert.equal(seen.untrustedState.proposedAction, 'fake');
});
test('event payload mutation after run cannot change provider state', async () => {
  let seen; const { mesh } = harness({ provider: new MockProvider(state => { seen = state; return result(); }) });
  const e = event(); const p = mesh.run(e, requestOptions()); e.state.intent = 'tampered'; await p;
  assert.equal(seen.untrustedState.intent, 'Read status.');
});
test('invalid type, oversized state, and duplicate registrations reject', async () => {
  const { mesh } = harness({ maxEventBytes: 4000 });
  await assert.rejects(mesh.run(event({ type: 'unknown' }), requestOptions()), /matching pack/);
  await assert.rejects(mesh.run(event({ state: 'x'.repeat(5000) }), requestOptions()), /size limit/);
  assert.throws(() => mesh.registerPack(toolPreflightPack), /already registered/);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, symlink, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync, fork } from 'node:child_process';
import { once } from 'node:events';
import { DatabaseSync } from 'node:sqlite';
import { MockProvider, toolPreflightPack } from '../dist/index.js';
import { SqliteKernel } from '../adapters/sqlite-kernel.mjs';
import { ShadowBoundary } from '../adapters/shadow-boundary.mjs';
import { TaskAwareBoundary } from '../adapters/task-boundary.mjs';
import { IntentCache } from '../adapters/intent-cache.mjs';
import { selectExplicitSummary, inspectTaskIntent, intentDigest, taskReceiptFromState, summaryStatus } from '../adapters/task-evidence.mjs';
import { observeClaudeTask, cacheOptions } from '../adapters/claude-task-hook.mjs';
import { openLocalBoundary } from '../adapters/local-config.mjs';
import { createMcpHandler } from '../adapters/mcp-server.mjs';
import { installDeepSeekObserver } from '../adapters/deepseek-plugin.mjs';
import { observeFunctionCall } from '../adapters/openai-compatible.mjs';

const scope = (overrides = {}) => ({ harness: 'claude-code', sessionId: 's1', agentId: 'root', ...overrides });
const call = (overrides = {}) => ({ schemaVersion: 1, ...scope(), callId: 'c1', toolName: 'Read', arguments: { path: 'README.md' }, ...overrides });
const intent = (overrides = {}) => ({ schemaVersion: 1, id: 'task-1', scope: scope(), source: 'host-declared', summary: 'Read README without editing files', issuedAt: 1000, expiresAt: 2000, ...overrides });
const binding = { providerId: 'mock', modelId: 'fixture', revision: '1', authorizationRevision: 'host', toolsetRevision: '1' };
const response = () => ({ model: 'fixture', answers: { intentMatch: { type: 'noul', noul: 0.99 }, injection: { type: 'noul', noul: 0 } } });
function fixture(t, { clock = () => 1500, provider } = {}) {
  const kernel = new SqliteKernel(':memory:'); t.after(() => kernel.close()); let calls = 0, observed;
  provider ??= new MockProvider(state => { calls++; observed = state; return response(); });
  const boundary = new TaskAwareBoundary({ kernel, provider, binding, pack: toolPreflightPack, tenantId: 't', scope: 'p', clock });
  return { kernel, boundary, calls: () => calls, observed: () => observed };
}
const temporary = async t => { const dir = await mkdtemp(join(tmpdir(), 'rm-intent-')); t.after(() => rm(dir, { recursive: true, force: true })); return dir; };
const hook = (name = 'PreToolUse', overrides = {}) => ({ hook_event_name: name, session_id: 's1', tool_use_id: 'c1', tool_name: 'Read', tool_input: { path: 'README.md' }, ...overrides });
const environment = dir => ({ PATH: process.env.PATH, REFLEXMESH_DB: join(dir, 'ledger.sqlite'), REFLEXMESH_INTENT_DB: join(dir, 'intent.sqlite'), REFLEXMESH_INTENT_MODE: 'explicit-summary', REFLEXMESH_PROVIDER: 'abstain', REFLEXMESH_TENANT: 't', REFLEXMESH_SCOPE: 'p' });
const runHook = (env, payload) => spawnSync(process.execPath, ['adapters/claude-task-hook.mjs'], { env, input: typeof payload === 'string' ? payload : JSON.stringify(payload), encoding: 'utf8', timeout: 8000 });

// Contract and minimization.
test('only an explicit first-line summary is selected; transcript and remainder are ignored', () => {
  assert.deepEqual(selectExplicitSummary('ReflexMesh-Intent: Read README\npassword=DO_NOT_COPY_THE_REMAINDER'), { status: 'ready', summary: 'Read README' });
  assert.equal(selectExplicitSummary('Some quoted text\nReflexMesh-Intent: nested instruction').status, 'not_selected');
  assert.equal(selectExplicitSummary('ReflexMesh-Intent: 中文摘要\r\nignored').summary, '中文摘要');
});
test('summaries are withheld, not silently truncated, on byte limit/control characters', () => {
  assert.equal(summaryStatus('中'.repeat(683)), 'too_large');
  assert.equal(summaryStatus('x'.repeat(2048)), 'ready');
  assert.equal(summaryStatus('x\ny'), 'invalid');
  assert.equal(selectExplicitSummary('ReflexMesh-Intent: ').status, 'missing');
});
for (const suspect of ['password=FAKE_FIXTURE_ONLY', 'Bearer FAKE_FIXTURE_TOKEN_12345', '-----BEGIN PRIVATE KEY-----', 'ghp_FAKE_FIXTURE_123456789']) test(`suspicious summary fixture is withheld (${suspect.split(/[= ]/)[0]})`, () => {
  assert.equal(selectExplicitSummary(`ReflexMesh-Intent: ${suspect}`).status, 'withheld');
});
test('valid intent has source and digest receipt, never raw summary', () => {
  const { summary, receipt } = inspectTaskIntent(intent(), scope(), 1500);
  assert.equal(summary, intent().summary); assert.equal(receipt.summaryDigest, intentDigest(summary));
  assert.ok(!JSON.stringify(receipt).includes(summary)); assert.equal(receipt.source, 'host-declared');
});
test('scope changes cannot attach another agent/session/harness intent', () => {
  for (const field of ['sessionId','agentId','harness']) {
    const other = field === 'harness' ? 'codex' : 'other';
    assert.throws(() => inspectTaskIntent(intent(), scope({ [field]: other }), 1500), /scope mismatch/);
  }
});
test('expired and future-dated intent has no usable summary', () => {
  for (const now of [999,2000,3000]) assert.equal(inspectTaskIntent(intent(), scope(), now).receipt.status, 'expired');
  assert.equal(inspectTaskIntent(intent(), scope(), 1999).receipt.status, 'ready');
});
test('invalid lifetime, extra fields, and forged model freshness are rejected', () => {
  for (const bad of [intent({ expiresAt: 601001 }), intent({ expiresAt: 1000 }), intent({ extra: 'private' }), intent({ source: 'model-reported' })]) assert.throws(() => inspectTaskIntent(bad, scope(), 1500));
});
test('model summary is explicitly unverified and cannot claim capture time', () => {
  const selected = inspectTaskIntent(intent({ source: 'model-reported', issuedAt: null, expiresAt: null }), scope(), 1500);
  assert.equal(selected.receipt.freshness, 'unverified'); assert.equal(selected.receipt.source, 'model-reported');
});
test('durable receipt rejects raw text fields and mismatched summary digests', () => {
  const selected = inspectTaskIntent(intent(), scope(), 1500);
  assert.throws(() => taskReceiptFromState({ userIntent: selected.summary, taskEvidence: { ...selected.receipt, rawPrompt: 'PRIVATE' } }));
  assert.throws(() => taskReceiptFromState({ userIntent: 'Different summary', taskEvidence: selected.receipt }), /mismatch/);
});
// Ephemeral store, not the execution journal.
test('intent survives separate connection reopen and stores only selected text', async t => {
  const dir = await temporary(t), path = join(dir, 'intent.sqlite');
  let cache = new IntentCache(path, { tenantId: 't', scope: 'p', clock: () => 1000 });
  cache.capture(scope(), 'ReflexMesh-Intent: Read README\nRAW_REMAINDER_MUST_NOT_BE_SAVED'); const original = cache.current(scope()); cache.close();
  cache = new IntentCache(path, { tenantId: 't', scope: 'p', clock: () => 1100 }); assert.deepEqual(cache.current(scope()), original); cache.close();
  assert.ok(!(await readFile(path)).includes(Buffer.from('RAW_REMAINDER_MUST_NOT_BE_SAVED')));
});
test('new unselected, oversized or sensitive prompts invalidate the previous task', () => {
  const cache = new IntentCache(':memory:', { tenantId: 't', scope: 'p', clock: () => 1000 });
  for (const prompt of ['Plain new instruction', `ReflexMesh-Intent: ${'x'.repeat(3000)}`, 'ReflexMesh-Intent: password=DO_NOT_STORE_THIS']) {
    cache.capture(scope(), 'ReflexMesh-Intent: Previous task'); cache.capture(scope(), prompt); assert.equal(cache.current(scope()), null);
  }
  cache.close();
});
test('TTL read boundary and clock rollback reject stale cached context', () => {
  let now = 1000; const cache = new IntentCache(':memory:', { tenantId: 't', scope: 'p', ttlMs: 100, clock: () => now });
  cache.capture(scope(), 'ReflexMesh-Intent: Read README'); now = 1100; assert.equal(cache.current(scope()), null);
  now = 1200; cache.capture(scope(), 'ReflexMesh-Intent: Other task'); now = 1199; assert.equal(cache.current(scope()), null); cache.close();
});
test('tenant, project, session and subagent context stay isolated', async t => {
  const dir = await temporary(t), path = join(dir, 'intent.sqlite');
  const a = new IntentCache(path, { tenantId: 't', scope: 'p', clock: () => 1000 }); a.capture(scope(), 'ReflexMesh-Intent: Main task');
  assert.equal(a.current(scope({ agentId: 'sub' })), null); assert.equal(a.current(scope({ sessionId: 's2' })), null);
  for (const opts of [{ tenantId: 'other', scope: 'p' }, { tenantId: 't', scope: 'other' }]) { const b = new IntentCache(path, { ...opts, clock: () => 1000 }); assert.equal(b.current(scope()), null); b.close(); }
  a.close();
});
test('capacity refuses extra context without evicting another task; pruning releases space', () => {
  let now = 1000; const c = new IntentCache(':memory:', { tenantId: 't', scope: 'p', maxSessions: 1, ttlMs: 100, clock: () => now });
  c.capture(scope(), 'ReflexMesh-Intent: First'); assert.equal(c.capture(scope({ sessionId: 's2' }), 'ReflexMesh-Intent: Second').status, 'capacity');
  assert.equal(c.current(scope()).summary, 'First'); now = 1100; assert.equal(c.prune(), 1); assert.equal(c.capture(scope({ sessionId: 's2' }), 'ReflexMesh-Intent: Second').status, 'ready'); c.close();
});
test('session clear removes its agents but not another session or tenant', async t => {
  const dir = await temporary(t), p = join(dir, 'intent.sqlite'); const a = new IntentCache(p, { tenantId: 't', scope: 'p', clock: () => 1000 });
  for (const s of [scope(),scope({ agentId: 'sub' }),scope({ sessionId: 's2' })]) a.capture(s, 'ReflexMesh-Intent: Task');
  const b = new IntentCache(p, { tenantId: 'other', scope: 'p', clock: () => 1000 }); b.capture(scope(), 'ReflexMesh-Intent: Other');
  assert.equal(a.clearSession(scope()), 2); assert.equal(a.current(scope()), null); assert.ok(a.current(scope({ sessionId: 's2' }))); assert.ok(b.current(scope())); a.close(); b.close();
});
test('intent cache refuses the real execution ledger without schema mutation', async t => {
  const p = join(await temporary(t), 'ledger.sqlite'); const k = new SqliteKernel(p); k.close();
  assert.throws(() => new IntentCache(p, { tenantId: 't', scope: 'p' }), /compatible intent cache/);
  const db = new DatabaseSync(p, { readOnly: true }); assert.equal(db.prepare('PRAGMA user_version').get().user_version, 2); db.close();
});
test('path alias collision and nonregular intent database are refused', async t => {
  const dir = await temporary(t), p = join(dir, 'db.sqlite');
  assert.throws(() => cacheOptions({ REFLEXMESH_INTENT_MODE: 'explicit-summary', REFLEXMESH_INTENT_DB: p, REFLEXMESH_DB: p }), /different files/);
  await mkdir(p); assert.throws(() => new IntentCache(p, { tenantId: 't', scope: 'p' }));
  const link = join(dir, 'link'); await symlink(p, link); assert.throws(() => new IntentCache(link, { tenantId: 't', scope: 'p' }));
});
// Provider gate and durable identity.
test('missing/withheld/expired intent skips provider even when it would answer confidently', async t => {
  const f = fixture(t);
  for (const [index, context] of [null, intent({ summary: 'password=DO_NOT_SEND_THIS' }), intent({ expiresAt: 1400 })].entries()) {
    const r = await f.boundary.before(call({ callId: `c${index}` }), context);
    assert.equal(r.verdict.effect, 'escalate'); assert.equal(r.control, 'abstain');
  }
  assert.equal(f.calls(), 0);
});
test('ready intent reaches provider; durable receipt and output contain no summary', async t => {
  const f = fixture(t), r = await f.boundary.before(call(), intent());
  assert.equal(f.calls(), 1); assert.equal(f.observed().userIntent, intent().summary); assert.equal(r.verdict.effect, 'allow');
  const saved = f.boundary.inspect(call()); assert.equal(saved.evidence.taskEvidence.summaryDigest, intentDigest(intent().summary));
  assert.ok(!JSON.stringify(saved).includes(intent().summary)); assert.ok(!JSON.stringify(r).includes(intent().summary));
});
test('same intent replays but changed intent for same call conflicts instead of silently rebinding', async t => {
  const f = fixture(t); await f.boundary.before(call(), intent()); assert.equal((await f.boundary.before(call(), intent())).replayed, true);
  await assert.rejects(f.boundary.before(call(), intent({ id: 'other', summary: 'Write a file' })), /conflict/); assert.equal(f.calls(), 1);
});
test('expired intent is not replaced with a previous successful cached decision', async t => {
  let now = 1500; const f = fixture(t, { clock: () => now }); await f.boundary.before(call(), intent()); now = 2000;
  await assert.rejects(f.boundary.before(call(), intent()), /conflict/); assert.equal(f.calls(), 1);
});
test('actual outcome links correctly after intent is cleared or a new task starts', async t => {
  const f = fixture(t); await f.boundary.before(call(), intent());
  f.boundary.after(call(), 'succeeded', { output: 'private' }); const row = f.boundary.inspect(call());
  assert.equal(row.observations.length, 1); assert.equal(row.labels.length, 0);
});
test('legacy observer remains available; deployment binding prevents old/new silent reuse', async t => {
  const f = fixture(t); const legacy = new ShadowBoundary({ kernel: f.kernel, provider: new MockProvider(response), binding, pack: toolPreflightPack, tenantId: 't', scope: 'p' });
  assert.equal((await legacy.before(call())).verdict.effect, 'allow');
  await assert.rejects(f.boundary.before(call(), intent()), /conflict/);
});
test('scope mismatch rejects before any provider call', async t => {
  const f = fixture(t); await assert.rejects(f.boundary.before(call(), intent({ scope: scope({ agentId: 'someone-else' }) })), /scope mismatch/); assert.equal(f.calls(), 0);
});
// Actual transport subprocesses and host callbacks, not installed CLI claims.
test('Claude prompt-to-tool-to-stop lifecycle persists selected context across subprocesses', async t => {
  const dir = await temporary(t), env = environment(dir);
  for (const payload of [hook('UserPromptSubmit', { prompt: 'ReflexMesh-Intent: Read README\nNO_TRANSCRIPT_RETENTION', transcript_path: '/this/must/not/be/read' }), hook(), hook('PostToolUse', { tool_response: { ok: true } })]) {
    const r = runHook(env, payload); assert.equal(r.status, 0, r.stderr); assert.deepEqual(JSON.parse(r.stdout), {});
  }
  const { boundary, kernel } = openLocalBoundary(env, { taskAware: true }); const row = boundary.inspect(call());
  assert.equal(row.evidence.taskEvidence.source, 'claude-explicit-summary'); assert.equal(row.evidence.taskEvidence.status, 'ready'); assert.equal(row.observations.length, 1); kernel.close();
  assert.ok(!(await readFile(env.REFLEXMESH_INTENT_DB)).includes(Buffer.from('NO_TRANSCRIPT_RETENTION')));
  assert.deepEqual(JSON.parse(runHook(env, hook('Stop')).stdout), {});
  const cache = new IntentCache(env.REFLEXMESH_INTENT_DB, { tenantId: 't', scope: 'p' }); assert.equal(cache.current(scope()), null); cache.close();
});
test('intent capture is off by default and lifecycle events create no database', async t => {
  const dir = await temporary(t), env = environment(dir); delete env.REFLEXMESH_INTENT_MODE;
  for (const name of ['UserPromptSubmit','Stop','SessionEnd']) {
    const r = runHook(env, hook(name, { prompt: 'ReflexMesh-Intent: Do not capture me' })); assert.equal(r.status, 0); assert.deepEqual(JSON.parse(r.stdout), {});
  }
  await assert.rejects(readFile(env.REFLEXMESH_INTENT_DB), { code: 'ENOENT' }); await assert.rejects(readFile(env.REFLEXMESH_DB), { code: 'ENOENT' });
});
test('invalid new prompt clears previous context across processes', async t => {
  const dir = await temporary(t), env = environment(dir);
  runHook(env, hook('UserPromptSubmit', { prompt: 'ReflexMesh-Intent: Old task' }));
  runHook(env, hook('UserPromptSubmit', { prompt: 'New task without explicit selection' })); runHook(env, hook());
  const { boundary, kernel } = openLocalBoundary(env, { taskAware: true }); assert.equal(boundary.inspect(call()).evidence.taskEvidence.status, 'missing'); kernel.close();
});
test('malformed, oversized or unknown task-hook input never prints payload or changes host permissions', async t => {
  const env = environment(await temporary(t));
  for (const payload of ['SECRET_NOT_JSON', 'x'.repeat(270000), hook('UnknownHook', { prompt: 'SECRET' })]) {
    const r = runHook(env, payload); assert.equal(r.status, 0); assert.deepEqual(JSON.parse(r.stdout), {}); assert.ok(!r.stderr.includes('SECRET'));
  }
});
test('failure and session-end lifecycle clears only configured scope', async t => {
  const dir = await temporary(t), env = environment(dir);
  for (const name of ['StopFailure','SessionEnd']) {
    runHook(env, hook('UserPromptSubmit', { prompt: 'ReflexMesh-Intent: Task' })); runHook(env, hook(name));
    const cache = new IntentCache(env.REFLEXMESH_INTENT_DB, { tenantId: 't', scope: 'p' }); assert.equal(cache.current(scope()), null); cache.close();
  }
});
test('Codex MCP summary provenance cannot be upgraded to host-declared or verified time', async t => {
  const f = fixture(t), handle = createMcpHandler(f.boundary);
  await handle({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } }); await handle({ jsonrpc: '2.0', method: 'notifications/initialized' });
  const c = call({ harness: 'codex' });
  const result = await handle({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'reflexmesh_assess', arguments: { call: c, userIntent: 'Read README' } } });
  const payload = JSON.parse(result.result.content[0].text); assert.equal(payload.taskEvidence.source, 'model-reported'); assert.equal(payload.taskEvidence.freshness, 'unverified');
  const spoof = await handle({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'reflexmesh_assess', arguments: { call: c, userIntent: 'Read README', source: 'host-declared' } } });
  assert.equal(spoof.error.code, -32602);
});
test('task-aware MCP real STDIO subprocess preserves protocol and explicit provenance', async t => {
  const env = environment(await temporary(t)); env.REFLEXMESH_TASK_EVIDENCE = 'true';
  const messages = [{ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } }, { jsonrpc: '2.0', method: 'notifications/initialized' },
    { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'reflexmesh_assess', arguments: { call: call({ harness: 'codex' }), userIntent: 'Read README' } } }];
  const r = spawnSync(process.execPath, ['adapters/mcp-server.mjs'], { env, input: messages.map(JSON.stringify).join('\n') + '\n', encoding: 'utf8', timeout: 8000 });
  assert.equal(r.status, 0, r.stderr); const responses = r.stdout.trim().split('\n').map(JSON.parse); assert.equal(responses.length, 2);
  assert.equal(JSON.parse(responses[1].result.content[0].text).taskEvidence.source, 'model-reported');
});
test('DeepSeek host resolver supplies scoped summary while preserving next decision', async t => {
  const f = fixture(t), handlers = new Map(), ctx = { on(k, fn) { handlers.set(k, fn); return () => handlers.delete(k); } };
  const s = scope({ harness: 'deepseek-harness' });
  const observer = installDeepSeekObserver(ctx, { boundary: f.boundary, identity: () => ({ sessionId: 's1', agentId: 'root' }), resolveIntent: () => intent({ scope: s }) });
  const result = await handlers.get('tools/pre-execute')({ callId: 'c1', name: 'Read', arguments: {}, signal: new AbortController().signal }, async () => ({ kind: 'ask', reason: 'host-owned' }));
  assert.deepEqual(result, { kind: 'ask', reason: 'host-owned' }); assert.equal(f.observed().userIntent, intent().summary); await observer.dispose();
});
test('function-call resolver failure does not cause host retries or change its result', async () => {
  let calls = 0; const original = { value: 'host' };
  const result = await observeFunctionCall({ boundary: { before() { throw new Error('must not get here'); }, after() {} },
    call: { id: 'c', type: 'function', function: { name: 'Read', arguments: '{}' } }, identity: { sessionId: 's', agentId: 'a' },
    resolveIntent() { throw new Error('FIXTURE_SECRET'); }, execute: async () => { calls++; return original; } });
  assert.equal(result, original); assert.equal(calls, 1);
});
test('simultaneous separate processes create one compatible intent cache with isolated records', { timeout: 10000 }, async t => {
  const dir = await temporary(t), path = join(dir, 'intent.sqlite');
  const children = Array.from({ length: 4 }, (_, i) => fork(new URL('./fixtures/intent-worker.mjs', import.meta.url), [path, String(i)], { stdio: ['ignore','ignore','pipe','ipc'] }));
  t.after(() => children.forEach(c => { if (c.exitCode === null) c.kill(); }));
  const results = await Promise.all(children.map(c => Promise.race([once(c, 'message').then(([v]) => v), once(c, 'exit').then(() => { throw new Error('Intent worker exited before reporting'); })])));
  assert.ok(results.every(x => x.ok === true), JSON.stringify(results));
  const cache = new IntentCache(path, { tenantId: 't', scope: 'p' });
  for (let i = 0; i < 4; i++) assert.equal(cache.current(scope({ sessionId: String(i) })).summary, `task ${i}`); cache.close();
});

test('task metadata is opt-in: old business events may use the taskEvidence field freely', async t => {
  const { DurableMesh } = await import('../adapters/durable-mesh.mjs');
  const kernel = new SqliteKernel(':memory:'); t.after(() => kernel.close());
  const mesh = new DurableMesh({ kernel, binding, provider: new MockProvider(response) }).registerPack(toolPreflightPack);
  const r = await mesh.run({ id: 'legacy-field', type: 'tool.requested', source: 'test', tenantId: 't', time: new Date().toISOString(), state: { taskEvidence: 'legacy free-text field' } }, { packId: 'tool-preflight' });
  assert.equal(r.verdict.effect, 'allow');
});
test('invalid missing-task receipts cannot smuggle raw summaries into metadata', () => {
  assert.throws(() => taskReceiptFromState({ userIntent: null, taskEvidence: { schemaVersion: 1, policy: 'explicit-summary-v1', status: 'missing', id: { raw: 'prompt' } } }));
  assert.throws(() => taskReceiptFromState({ userIntent: 'SECRET', taskEvidence: { schemaVersion: 1, policy: 'explicit-summary-v1', status: 'missing' } }));
});
test('async or never-settling host resolver cannot hang the original function call', { timeout: 1000 }, async () => {
  for (const resolveIntent of [() => new Promise(() => {}), async () => { throw new Error('FIXTURE_SECRET'); }]) {
    let calls = 0;
    const result = await observeFunctionCall({ boundary: { before() { throw new Error('must be skipped'); }, after() {} },
      call: { id: 'c', type: 'function', function: { name: 'Read', arguments: '{}' } }, identity: { sessionId: 's', agentId: 'a' },
      resolveIntent, execute: async () => { calls++; return 'host-result'; } });
    assert.equal(result, 'host-result'); assert.equal(calls, 1);
  }
});
test('DeepSeek abort during synchronous resolver does not call the provider or replace next()', async () => {
  const controller = new AbortController(), handlers = new Map(); let assessments = 0;
  const observer = installDeepSeekObserver({ on(k, fn) { handlers.set(k, fn); return () => handlers.delete(k); } }, {
    boundary: { before() { assessments++; }, after() {} }, identity: () => ({ sessionId: 's1', agentId: 'root' }),
    resolveIntent() { controller.abort(); return null; },
  });
  const r = await handlers.get('tools/pre-execute')({ signal: controller.signal }, async () => ({ kind: 'cancel' }));
  assert.deepEqual(r, { kind: 'cancel' }); assert.equal(assessments, 0); await observer.dispose();
});
test('intent expiring between admission and provider egress is never sent', async t => {
  let now = 1500; const f = fixture(t, { clock: () => now });
  const append = f.kernel.append.bind(f.kernel);
  f.kernel.append = (handle, row) => { append(handle, row); if (row.kind === 'decision.started') now = 2100; };
  const r = await f.boundary.before(call(), intent()); assert.equal(r.verdict.effect, 'escalate'); assert.equal(f.calls(), 0);
});
test('offline task demo shows missing evidence skip, selected-summary replay and post-clear abstention', () => {
  const r = spawnSync(process.execPath, ['examples/task-intent.mjs'], { encoding: 'utf8', timeout: 5000 });
  assert.equal(r.status, 0, r.stderr); const demo = JSON.parse(r.stdout);
  assert.equal(demo.missingIntent.providerCalls, 0); assert.equal(demo.totalFixturePredictions, 1);
  assert.equal(demo.selectedIntent.receipt.coverage, 'summary-only'); assert.equal(demo.afterStop.effect, 'escalate');
  assert.equal(demo.selectedSummaryInJournal, false); assert.equal(demo.unselectedBodyInCache, false); assert.equal(demo.labelsCreated, 0);
});
test('invalid clock after admission cannot bypass the last egress freshness check', async t => {
  let now = 1500; const f = fixture(t, { clock: () => now }), append = f.kernel.append.bind(f.kernel);
  f.kernel.append = (h, r) => { append(h, r); if (r.kind === 'decision.started') now = NaN; };
  // The provider guard rejects; restoring time for the metadata-only inspect avoids masking the result.
  const inspect = f.boundary.inspect.bind(f.boundary); f.boundary.inspect = c => { now = 1500; return inspect(c); };
  const r = await f.boundary.before(call(), intent()); assert.equal(r.verdict.effect, 'escalate'); assert.equal(f.calls(), 0);
});

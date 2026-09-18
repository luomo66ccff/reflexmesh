import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { MockProvider, toolPreflightPack, compilePortablePack, fromClaudeHook, fromDeepSeekCall, fromOpenAICompatible } from '../dist/index.js';
import { result } from './helpers.mjs';
import { SqliteKernel } from '../adapters/sqlite-kernel.mjs';
import { ShadowBoundary } from '../adapters/shadow-boundary.mjs';
import { installDeepSeekObserver } from '../adapters/deepseek-plugin.mjs';
import { observeFunctionCall } from '../adapters/openai-compatible.mjs';
import { observeClaude } from '../adapters/claude-hook.mjs';
import { createMcpHandler } from '../adapters/mcp-server.mjs';
import { jsonLines } from '../adapters/stdio.mjs';
import { openLocalBoundary } from '../adapters/local-config.mjs';

const binding = { providerId: 'mock', modelId: 'fixture', revision: 'fixture-v1', authorizationRevision: 'host-owned-shadow', toolsetRevision: 'host-owned-shadow', calibrationRef: null };
const call = (overrides = {}) => ({ schemaVersion: 1, harness: 'codex', sessionId: 's1', agentId: 'root', callId: 'c1', toolName: 'Read', arguments: { path: 'README.md' }, ...overrides });
const hook = (overrides = {}) => ({ session_id: 's1', hook_event_name: 'PreToolUse', tool_use_id: 'c1', tool_name: 'Read', tool_input: { path: 'README.md' }, ...overrides });
function fixture(t, scope = 'project') {
  const kernel = new SqliteKernel(':memory:'); t.after(() => kernel.close());
  const boundary = new ShadowBoundary({ kernel, provider: new MockProvider(result), binding, pack: toolPreflightPack, tenantId: 'tenant', scope });
  return { kernel, boundary };
}
const disk = async t => { const dir = await mkdtemp(join(tmpdir(), 'reflexmesh-adapters-')); t.after(() => rm(dir, { recursive: true, force: true })); return join(dir, 'state.sqlite'); };
const envFor = path => ({ PATH: process.env.PATH, REFLEXMESH_DB: path, REFLEXMESH_PROVIDER: 'abstain', REFLEXMESH_TENANT: 'test', REFLEXMESH_SCOPE: 'test' });
const rpc = (id, method, params) => ({ jsonrpc: '2.0', id, method, ...(params ? { params } : {}) });
const initialize = rpc(1, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'fixture', version: '1' } });
const initialized = { jsonrpc: '2.0', method: 'notifications/initialized' };

test('portable binary/choice/ordinal compiles without breaking legacy questions', () => {
  const pack = compilePortablePack({ id: 'portable', version: '1', schemaVersion: 1, eventType: 'test', questions: {
    b: { type: 'binary', instructions: 'Binary?' }, c: { type: 'choice', instructions: 'Choose', choices: { yes: 'Y', no: 'N' } }, o: { type: 'ordinal', instructions: 'Score', levels: ['low','high'] },
  }, rules: [], fallback: 'escalate' });
  assert.deepEqual(Object.values(pack.questions).map(q => q.type), ['noul','choice','score']);
  assert.throws(() => compilePortablePack({ schemaVersion: 2 }), /schema/);
  assert.equal(toolPreflightPack.questions.intentMatch.type, 'noul');
});
test('three actual harness-shaped calls share one question and policy contract', async t => {
  const { boundary } = fixture(t);
  const calls = [call(), fromClaudeHook(hook()).call, fromDeepSeekCall({ callId: 'c1', name: 'Read', arguments: { path: 'README.md' } }, { sessionId: 's1', agentId: 'root' })];
  const results = await Promise.all(calls.map(c => boundary.before(c)));
  assert.ok(results.every(r => r.mode === 'shadow' && r.control === 'abstain' && r.verdict.effect === 'allow'));
  assert.equal(new Set(results.map(r => r.decisionId)).size, 3);
  const hashes = calls.map(c => boundary.inspect(c).evidence.pack.digest); assert.equal(new Set(hashes).size, 1);
});
test('harness session, agent, scope and tenant are isolated evidence namespaces', async t => {
  const { boundary, kernel } = fixture(t), c = call();
  const first = await boundary.before(c), agent = await boundary.before(call({ agentId: 'other' })), session = await boundary.before(call({ sessionId: 'other' }));
  const other = new ShadowBoundary({ kernel, provider: new MockProvider(result), binding, pack: toolPreflightPack, tenantId: 'other', scope: 'project' });
  const tenant = await other.before(c); assert.equal(new Set([first, agent, session, tenant].map(r => r.decisionId)).size, 4);
  // Namespace separation is not authentication. All constructors here are trusted host code.
});
test('outcomes bind exact action, reject orphans, and never create truth labels', async t => {
  const { boundary } = fixture(t), c = call();
  assert.throws(() => boundary.after(c, 'succeeded', {}), /Orphan/);
  await boundary.before(c, 'Read the README.');
  assert.throws(() => boundary.after(call({ arguments: { path: 'secret' } }), 'succeeded', {}), /mismatch/);
  boundary.after(c, 'succeeded', { private: 'OUTPUT_SECRET' }); boundary.after(c, 'succeeded', { private: 'OUTPUT_SECRET' });
  const record = boundary.inspect(c); assert.equal(record.observations.length, 1); assert.equal(record.labels.length, 0);
  assert.ok(!JSON.stringify(record).includes('OUTPUT_SECRET'));
  await assert.rejects(boundary.before(call({ arguments: { changed: true } })), /conflict/);
});
test('Claude normalization uses tool_use_id and handles post failures', () => {
  assert.equal(fromClaudeHook(hook()).call.callId, 'c1');
  const failure = fromClaudeHook(hook({ hook_event_name: 'PostToolUseFailure', error: 'test-failure' }));
  assert.equal(failure.phase, 'after'); assert.equal(failure.status, 'failed');
  assert.throws(() => fromClaudeHook({ ...hook(), tool_use_id: undefined }));
});
test('Claude observer always abstains even for a semantically allowed tool', async t => {
  const { boundary } = fixture(t); assert.deepEqual(await observeClaude(hook(), boundary), {});
  assert.deepEqual(await observeClaude(hook({ hook_event_name: 'PostToolUse', tool_response: {} }), boundary), {});
  assert.equal(boundary.inspect(fromClaudeHook(hook()).call).observations[0].provenance, 'harness-reported');
});
test('Claude CLI consumes real hook JSON shape and persists across separate processes', async t => {
  const path = await disk(t), env = envFor(path);
  for (const payload of [hook(), hook({ hook_event_name: 'PostToolUse', tool_response: { contents: 'NO_RAW_OUTPUT' } })]) {
    const r = spawnSync(process.execPath, ['adapters/claude-hook.mjs'], { input: JSON.stringify(payload), env, encoding: 'utf8', timeout: 7000 });
    assert.equal(r.status, 0, r.stderr); assert.deepEqual(JSON.parse(r.stdout), {});
  }
  const { boundary, kernel } = openLocalBoundary(env); t.after(() => kernel.close());
  const row = boundary.inspect(fromClaudeHook(hook()).call); assert.equal(row.result.verdict.effect, 'escalate');
  assert.equal(row.observations[0].status, 'succeeded'); assert.ok(!JSON.stringify(row).includes('NO_RAW_OUTPUT'));
});
test('malformed Claude input and oversized frame do not grant or deny permission', async () => {
  for (const input of ['not-json-SECRET', 'x'.repeat(270000)]) {
    const r = spawnSync(process.execPath, ['adapters/claude-hook.mjs'], { input, env: { PATH: process.env.PATH }, encoding: 'utf8', timeout: 7000 });
    assert.equal(r.status, 0); assert.deepEqual(JSON.parse(r.stdout), {}); assert.ok(!r.stderr.includes('SECRET'));
  }
});
test('DeepSeek observer uses real waterfall fields, preserves next and disposes hooks', async t => {
  const { boundary } = fixture(t), handlers = new Map(); let delegated = 0;
  const ctx = { on(name, fn) { handlers.set(name, fn); return () => handlers.delete(name); } };
  const observer = installDeepSeekObserver(ctx, { boundary, identity: () => ({ sessionId: 's1', agentId: 'root' }) });
  const exec = { callId: 'c1', name: 'Read', arguments: { path: 'README.md' }, signal: new AbortController().signal };
  const original = { kind: 'ask', reason: 'host requires approval' };
  assert.equal(await handlers.get('tools/pre-execute')(exec, async () => { delegated++; return original; }), original);
  assert.equal(delegated, 1);
  assert.equal(handlers.get('tools/result')(exec, { isError: false, value: { ok: true }, content: [] }), undefined);
  await observer.flush(); assert.equal(boundary.inspect(fromDeepSeekCall(exec, { sessionId: 's1', agentId: 'root' })).observations.length, 1);
  await observer.dispose(); assert.equal(handlers.size, 0);
});
test('DeepSeek observation failures cannot replace the host decision', async () => {
  const handlers = new Map(), diagnostics = [];
  const observer = installDeepSeekObserver({ on(k, fn) { handlers.set(k, fn); return () => handlers.delete(k); } }, {
    boundary: { before() { throw new Error('SECRET'); }, after() { throw new Error('SECRET'); } },
    identity: () => ({ sessionId: 's', agentId: 'a' }), onError: e => diagnostics.push(e),
  });
  const exec = { callId: 'c', name: 'Read', arguments: {}, signal: new AbortController().signal };
  assert.deepEqual(await handlers.get('tools/pre-execute')(exec, async () => ({ kind: 'deny', reason: 'host denied' })), { kind: 'deny', reason: 'host denied' });
  handlers.get('tools/result')(exec, { isError: true, error: { message: 'PRIVATE' } }); await observer.dispose();
  assert.equal(diagnostics.length, 2); assert.ok(diagnostics.every(x => !x.includes('SECRET')));
});
test('OpenAI-compatible wrapper executes once when observer fails and preserves original errors', async () => {
  const fn = { id: 'c', type: 'function', function: { name: 'Read', arguments: '{"path":"README.md"}' } };
  assert.deepEqual(fromOpenAICompatible(fn, { sessionId: 's', agentId: 'a' }).arguments, { path: 'README.md' });
  assert.throws(() => fromOpenAICompatible({ ...fn, function: { ...fn.function, arguments: 'not JSON' } }, { sessionId: 's', agentId: 'a' }));
  let count = 0; const original = new Error('original');
  const params = { boundary: { before() { throw new Error('observer'); }, after() { throw new Error('observer'); } }, call: fn, identity: { sessionId: 's', agentId: 'a' } };
  assert.deepEqual(await observeFunctionCall({ ...params, execute: async () => { count++; return { result: true }; } }), { result: true });
  await assert.rejects(observeFunctionCall({ ...params, execute: async () => { count++; throw original; } }), e => e === original);
  assert.equal(count, 2);
});
test('MCP tools are advisory, model-reported outcomes cannot create labels', async t => {
  const { boundary } = fixture(t), handle = createMcpHandler(boundary), c = call();
  assert.equal((await handle(rpc(0, 'tools/list'))).error.code, -32000);
  assert.equal((await handle(initialize)).result.protocolVersion, '2025-06-18'); await handle(initialized);
  const list = await handle(rpc(2, 'tools/list')); assert.equal(list.result.tools.length, 4);
  const r = await handle(rpc(3, 'tools/call', { name: 'reflexmesh_assess', arguments: { call: c } }));
  assert.equal(JSON.parse(r.result.content[0].text).control, 'abstain');
  const outcome = await handle(rpc(4, 'tools/call', { name: 'reflexmesh_observe_outcome', arguments: { call: c, status: 'succeeded', evidence: { asserted: true } } }));
  assert.equal(outcome.result.isError, undefined); assert.equal(boundary.inspect(c).observations[0].provenance, 'model-reported'); assert.deepEqual(boundary.inspect(c).labels, []);
  const replay = await handle(rpc(5, 'tools/call', { name: 'reflexmesh_replay_policy', arguments: { call: c } }));
  assert.equal(JSON.parse(replay.result.content[0].text).executionAllowed, false);
});
test('MCP rejects unknown methods/tools, extra arguments and initialization misuse', async t => {
  const { boundary } = fixture(t), handle = createMcpHandler(boundary);
  assert.equal((await handle([])).error.code, -32600); await handle(initialize); await handle(initialized);
  assert.equal((await handle(initialize)).error.code, -32602);
  assert.equal((await handle(rpc(2, 'execute'))).error.code, -32601);
  assert.equal((await handle(rpc(3, 'tools/call', { name: 'shell', arguments: {} }))).error.code, -32602);
  assert.equal((await handle(rpc(4, 'tools/call', { name: 'reflexmesh_inspect_pack', arguments: { db: '/another' } }))).error.code, -32602);
});
test('real MCP STDIO subprocess yields only framed JSON-RPC, without real API access', async t => {
  const path = await disk(t);
  const lines = [initialize, initialized, rpc(2, 'tools/list'), rpc(3, 'tools/call', { name: 'reflexmesh_assess', arguments: { call: call() } }), rpc(4, 'ping')];
  const r = spawnSync(process.execPath, ['adapters/mcp-server.mjs'], { input: lines.map(JSON.stringify).join('\n') + '\n', env: envFor(path), encoding: 'utf8', timeout: 7000 });
  assert.equal(r.status, 0, r.stderr);
  const messages = r.stdout.trim().split('\n').map(JSON.parse); assert.equal(messages.length, 4); assert.ok(messages.every(m => m.jsonrpc === '2.0'));
  const assessment = JSON.parse(messages[2].result.content[0].text); assert.equal(assessment.verdict.effect, 'escalate'); assert.equal(assessment.provider, undefined);
});
test('STDIO framing validates byte size, incomplete frames, and split UTF-8', async () => {
  const bytes = Buffer.from('{"a":"中文"}\n'); let lines = [];
  for await (const line of jsonLines(Readable.from([bytes.subarray(0,8), bytes.subarray(8)]))) lines.push(line);
  assert.deepEqual(JSON.parse(lines[0]), { a: '中文' });
  await assert.rejects(async () => { for await (const _ of jsonLines(Readable.from(['xxx']), 2)) {} }, /limit/);
  await assert.rejects(async () => { for await (const _ of jsonLines(Readable.from(['{}']))) {} }, /Incomplete/);
});
test('live provider requires explicit egress opt-in before opening storage', () => {
  assert.throws(() => openLocalBoundary({ REFLEXMESH_PROVIDER: 'jev' }), /ALLOW_REMOTE/);
  assert.throws(() => openLocalBoundary({ REFLEXMESH_PROVIDER: 'jev', REFLEXMESH_ALLOW_REMOTE: 'true' }), /revision/);
});

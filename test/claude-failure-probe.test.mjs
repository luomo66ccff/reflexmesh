import assert from 'node:assert/strict';
import test from 'node:test';
import { existsSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { createClaudeSettings } from '../adapters/claude-setup.mjs';
import { digest } from '../adapters/sqlite-kernel.mjs';
import { eventKey } from '../adapters/durable-mesh.mjs';
import { evaluateClaudeFailureRun, runClaudeFailureProbe, main, FAILURE_SUMMARY } from '../scripts/claude-failure-probe.mjs';
import { FAILURE_CALLS, FAILURE_TOOL } from '../scripts/claude-failure-server.mjs';

function valid() {
  const session = 'synthetic-session', ledger = join(tmpdir(), 'synthetic-failure-ledger.sqlite'), intent = join(tmpdir(), 'synthetic-failure-intent.sqlite');
  const stream = [];
  for (const [index, event] of ['UserPromptSubmit', 'PreToolUse', 'PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'Stop'].entries()) {
    stream.push({ type: 'system', subtype: 'hook_started', hook_event: event, hook_id: `h${index}`, session_id: session });
    stream.push({ type: 'system', subtype: 'hook_response', hook_event: event, hook_id: `h${index}`, session_id: session,
      exit_code: 0, outcome: 'success', stdout: '{}\n', stderr: '' });
  }
  stream.push({ type: 'assistant', session_id: session, message: { content: structuredClone(FAILURE_CALLS) } });
  const records = FAILURE_CALLS.map(call => {
    const content = call.id === 'fixture_fail' ? 'synthetic-failure' : [{ type: 'text', text: 'synthetic-success' }];
    stream.push({ type: 'user', session_id: session, message: { content: [{ type: 'tool_result', tool_use_id: call.id,
      content, ...(call.id === 'fixture_fail' ? { is_error: true } : {}) }] }, tool_use_result: content });
    return { key: eventKey({ tenantId: 'synthetic-failure-probe', source: 'reflexmesh:mixed-outcomes:claude-code',
      id: digest([session, 'root', call.id, 'before']) }), state: 'completed', labels: [],
      evidence: { mode: 'shadow', binding: { providerId: 'abstain', modelId: 'not-configured' },
        actionDigest: digest({ toolId: FAILURE_TOOL, args: call.input }), taskEvidence: { status: 'ready', source: 'claude-explicit-summary',
          coverage: 'summary-only', summaryDigest: digest(FAILURE_SUMMARY), scopeDigest: digest({ harness: 'claude-code', sessionId: session, agentId: 'root' }) } },
      observations: [{ status: call.id === 'fixture_fail' ? 'failed' : 'succeeded', provenance: 'harness-reported', evidenceDigest: digest(content) }] };
  });
  stream.push({ type: 'result', subtype: 'success', is_error: false, session_id: session, result: 'REFLEXMESH_CLAUDE_FAILURE_OK' });
  return { stdout: stream.map(JSON.stringify).join('\n'), records, ledger, intent,
    settings: structuredClone(createClaudeSettings({ dbPath: ledger, intentDbPath: intent, tenantId: 'synthetic-failure-probe', scope: 'mixed-outcomes', intentMode: 'explicit-summary' })),
    childEnv: {}, pairs: [{ state: 'ready', reasonCode: null }, { state: 'ready', reasonCode: null }],
    schemaVersion: 3, pairCount: 2, cacheCount: 0, minimized: true,
    transport: { helloRequests: 1, messageRequests: 2, resultMatched: true, completed: true, boundedFailure: 'none' },
    receipts: [{ event: 'entered', mode: 'ok', active: 1 }, { event: 'entered', mode: 'fail', active: 2 },
      { event: 'exited', mode: 'ok', active: 1, overlapping: true }, { event: 'exited', mode: 'fail', active: 0, overlapping: true }] };
}
const changeStream = (value, fn) => { const stream = value.stdout.split('\n').map(JSON.parse); fn(stream); value.stdout = stream.map(JSON.stringify).join('\n'); };

test('mixed outcome verifier accepts exact two-call evidence', () => {
  const assertions = evaluateClaudeFailureRun(valid());
  assert.equal(assertions.length, 19); assert.ok(assertions.every(item => item.passed));
});
for (const [name, mutate] of [
  ['inherited observer fallback', v => { v.childEnv.reflexmesh_db = 'old'; }],
  ['permission grants', v => { v.settings.permissions = {}; }],
  ['wrapper instead of production', v => { v.settings.hooks.Stop[0].hooks[0].args[0] = 'wrapper'; }],
  ['wrong deployment database', v => { v.settings.env.REFLEXMESH_DB = 'old'; }],
  ['missing summary opt-in', v => { v.settings.env.REFLEXMESH_INTENT_MODE = 'off'; }],
  ['foreign call session', v => changeStream(v, s => { s.find(x => x.type === 'assistant').session_id = 'foreign'; })],
  ['extra native call', v => changeStream(v, s => { s.find(x => x.type === 'assistant').message.content.push({ ...FAILURE_CALLS[0] }); })],
  ['wrong native argument', v => changeStream(v, s => { s.find(x => x.type === 'assistant').message.content[0].input.mode = 'fail'; })],
  ['foreign result session', v => changeStream(v, s => { s.find(x => x.type === 'user').session_id = 'foreign'; })],
  ['failed result presented as success', v => changeStream(v, s => { s.filter(x => x.type === 'user')[1].message.content[0].is_error = false; })],
  ['missing failure hook', v => changeStream(v, s => { s.splice(s.findIndex(x => x.hook_event === 'PostToolUseFailure'), 1); })],
  ['hook response for foreign ID', v => changeStream(v, s => { s[1].hook_id = 'foreign'; })],
  ['observer warning', v => changeStream(v, s => { s[1].stderr = 'ReflexMesh task observation unavailable'; })],
  ['nonzero hook exit', v => changeStream(v, s => { s[1].exit_code = 1; })],
  ['unknown hook status', v => changeStream(v, s => { s[1].outcome = 'failed'; })],
  ['StopFailure', v => changeStream(v, s => { s[10].hook_event = 'StopFailure'; s[11].hook_event = 'StopFailure'; })],
  ['final before Stop', v => changeStream(v, s => { const last = s.pop(); s.unshift(last); })],
  ['missing final session', v => changeStream(v, s => { delete s.at(-1).session_id; })],
  ['no actual tool overlap', v => { v.receipts[1].active = 1; }],
  ['barrier timed out', v => { v.receipts[2].overlapping = false; }],
  ['extra fixture activity', v => { v.receipts.push({ event: 'rejected' }); }],
  ['extra model request', v => { v.transport.messageRequests++; }],
  ['missing exact ledger key', v => { v.records[0].key = 'foreign'; }],
  ['blocked pairing', v => { v.pairs[1].state = 'blocked'; }],
  ['outcomes swapped between calls', v => { [v.records[0].observations, v.records[1].observations] = [v.records[1].observations, v.records[0].observations]; }],
  ['wrong native digest', v => { v.records[1].observations[0].evidenceDigest = digest('wrong'); }],
  ['false truth provenance', v => { v.records[1].observations[0].provenance = 'test-oracle'; }],
  ['wrong task binding', v => { v.records[1].evidence.taskEvidence.summaryDigest = digest('wrong'); }],
  ['generated truth labels', v => { v.records[1].labels = [{}]; }],
  ['cache not cleared at exit', v => { v.cacheCount = 1; }],
  ['raw ledger output', v => { v.minimized = false; }],
  ['malformed JSONL', v => { v.stdout += '\ninvalid'; }],
]) test(`mixed outcome verifier rejects ${name}`, () => {
  const value = valid(); mutate(value); assert.ok(evaluateClaudeFailureRun(value).some(item => !item.passed));
});

test('exact Node SQLite warning is allowed but no arbitrary stderr', () => {
  const value = valid(); changeStream(value, s => {
    for (const hook of s.filter(x => x.subtype === 'hook_response')) hook.stderr =
      '(node:123) ExperimentalWarning: SQLite is an experimental feature and might change at any time\n(Use `node --trace-warnings ...` to show where the warning was created)\n';
  }); assert.ok(evaluateClaudeFailureRun(value).every(item => item.passed));
});

function workspace(t) {
  const root = mkdtempSync(join(tmpdir(), 'reflexmesh-failure-probe-test-')), canary = join(root, 'unrelated');
  writeFileSync(canary, 'preserve');
  t.after(() => {
    const target = realpathSync(root); assert.equal(dirname(target), realpathSync(tmpdir()));
    assert.ok(basename(target).startsWith('reflexmesh-failure-probe-test-')); rmSync(target, { recursive: true, force: true });
  });
  return { root, canary, deps: { platform: 'win32', systemTemp: root, ancestorCheck: () => true, managedCheck: async () => true,
    resolveHost: () => process.execPath, runVersion: async () => ({ ok: true, stdout: '2.1.263 (Claude Code)' }),
    doctor: async args => ({ exitCode: 0, report: { setup: { settings: createClaudeSettings({ dbPath: args[args.indexOf('--db') + 1],
      intentDbPath: args[args.indexOf('--intent-db') + 1], tenantId: 'synthetic-failure-probe', scope: 'mixed-outcomes', intentMode: 'explicit-summary' }) } } }) } };
}

for (const mode of ['timeout', 'stdout_limit', 'ignored_hooks']) test(`${mode} cannot pass or retain the fixture listener`, async t => {
  const f = workspace(t); let directory, endpoint;
  const result = await runClaudeFailureProbe({}, { ...f.deps, runHost: async (exe, args, opts) => {
    directory = opts.cwd; endpoint = opts.env.ANTHROPIC_BASE_URL;
    assert.equal(Object.keys(opts.env).some(key => /^REFLEXMESH_/i.test(key)), false);
    const mcp = JSON.parse(args[args.indexOf('--mcp-config') + 1]);
    assert.deepEqual(Object.keys(mcp.mcpServers), ['reflexmesh_fixture']);
    assert.equal(args[args.indexOf('--tools') + 1], '');
    return mode === 'ignored_hooks' ? { ok: true, stdout: valid().stdout } : { ok: false, kind: mode };
  } });
  assert.equal(result.status, 'failed');
  assert.equal(result.reason, { timeout: 'host_timeout', stdout_limit: 'host_stdout_limit_exceeded', ignored_hooks: 'probe_assertion_failed' }[mode],
    JSON.stringify(result.diagnostic));
  assert.equal(result.diagnostic, undefined);
  assert.equal(existsSync(directory), false); assert.equal(readFileSync(f.canary, 'utf8'), 'preserve');
  await assert.rejects(fetch(endpoint, { signal: AbortSignal.timeout(500) }));
});

for (const [name, code, expected] of [
  ['fixture bind EACCES', 'EACCES', 'EACCES'],
  ['unknown private fixture error', 'PRIVATE_FAILURE_CODE', 'unknown'],
]) test(`${name} reports only a fixed diagnostic and leaves no listener`, async t => {
  const f = workspace(t);
  let hostCalls = 0;
  const privateText = 'PRIVATE_TOKEN C:\\private\\ledger.sqlite';
  const result = await runClaudeFailureProbe({}, { ...f.deps,
    startFixture: async () => { throw Object.assign(new Error(privateText), { code }); },
    runHost: async () => { hostCalls++; throw new Error('host must not start'); },
  });
  assert.equal(result.status, 'failed');
  assert.equal(result.reason, 'probe_execution_failed');
  assert.deepEqual(result.diagnostic, { phase: 'fixture_bind', code: expected });
  assert.equal(hostCalls, 0);
  assert.deepEqual(readdirSync(f.root), ['unrelated']);
  assert.equal(readFileSync(f.canary, 'utf8'), 'preserve');
  assert.equal(JSON.stringify(result).includes(privateText), false);
  assert.equal(JSON.stringify(result).includes('PRIVATE_FAILURE_CODE'), false);
});

test('doctor refusal and policy refusal never start a host', async t => {
  const f = workspace(t); let calls = 0;
  const runHost = async () => { calls++; throw new Error('must not run'); };
  const policy = await runClaudeFailureProbe({}, { ...f.deps, runHost, managedCheck: async () => false });
  assert.equal(policy.reason, 'managed_configuration_unverified');
  const doctor = await runClaudeFailureProbe({}, { ...f.deps, runHost, doctor: async () => ({ exitCode: 1 }) });
  assert.equal(doctor.reason, 'doctor_prerequisites_failed'); assert.equal(calls, 0);
});

test('cleanup failure remains failure and unrelated files survive', async t => {
  const f = workspace(t);
  const result = await runClaudeFailureProbe({}, { ...f.deps, doctor: async () => ({ exitCode: 1 }),
    remove: () => { throw new Error('synthetic cleanup fault'); } });
  assert.equal(result.reason, 'probe_cleanup_failed'); assert.equal(readFileSync(f.canary, 'utf8'), 'preserve');
});

test('help and fixed invalid-options output make the cancellation evidence limit explicit', async () => {
  let text = ''; const output = { write(value) { text += value; } };
  assert.equal(await main(['--help'], output), 0); assert.match(text, /Does not prove actual cancellation/);
  text = ''; assert.equal(await main(['--private', 'secret'], output), 1);
  assert.equal(JSON.parse(text).reason, 'invalid_options'); assert.equal(text.includes('secret'), false);
  const result = await runClaudeFailureProbe({ timeoutMs: -1 }); assert.equal(result.reason, 'invalid_options');
});

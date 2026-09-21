import assert from 'node:assert/strict';
import test from 'node:test';
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { createClaudeSettings } from '../adapters/claude-setup.mjs';
import { digest } from '../adapters/sqlite-kernel.mjs';
import { eventKey } from '../adapters/durable-mesh.mjs';
import { evaluateClaudeSetupRun, runClaudeSetupScenario, runClaudeSetupProbe, main } from '../scripts/claude-setup-probe.mjs';

const events = ['UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'Stop'];
function validEvidence(optIn = false) {
  const scenario = optIn ? 'explicit-summary' : 'capture-off';
  const scope = `setup-${scenario}`, sessionId = 'synthetic-session';
  const fixture = join(tmpdir(), 'synthetic-setup-fixture.txt');
  const callId = 'reflexmesh_fixture_read', args = { file_path: fixture };
  const nativeResult = { type: 'text', file: { content: 'synthetic-output' } };
  const hooks = events.flatMap(event => [
    { type: 'system', subtype: 'hook_started', hook_event: event, hook_id: event, session_id: sessionId },
    { type: 'system', subtype: 'hook_response', hook_event: event, hook_id: event, session_id: sessionId,
      stdout: '{}\n', stderr: '', exit_code: 0, outcome: 'success' }]);
  const stdout = [...hooks,
    { type: 'assistant', session_id: sessionId, message: { content: [{ type: 'tool_use', id: callId, name: 'Read', input: args }] } },
    { type: 'user', session_id: sessionId, message: { content: [{ type: 'tool_result', tool_use_id: callId, content: 'synthetic-output' }] }, tool_use_result: nativeResult },
    { type: 'result', session_id: sessionId, is_error: false, subtype: 'success', result: 'REFLEXMESH_CLAUDE_SETUP_OK' },
  ].map(JSON.stringify).join('\n');
  const key = eventKey({ tenantId: 'synthetic-setup-probe', source: `reflexmesh:${scope}:claude-code`,
    id: digest([sessionId, 'root', callId, 'before']) });
  return { scenario, fixture, stdout, childEnv: { ANTHROPIC_API_KEY: 'synthetic-only' },
    settings: structuredClone(createClaudeSettings({ dbPath: join(tmpdir(), 'synthetic-ledger.sqlite'),
      tenantId: 'synthetic-setup-probe', scope, intentMode: optIn ? 'explicit-summary' : 'off' })),
    records: [{ key, state: 'completed', evidence: { mode: 'shadow', actionDigest: digest({ toolId: 'Read', args }),
      binding: { providerId: 'abstain', modelId: 'not-configured' },
      taskEvidence: optIn ? { status: 'ready', source: 'claude-explicit-summary', coverage: 'summary-only',
        summaryDigest: digest('Read only the isolated setup fixture; do not modify files.'),
        scopeDigest: digest({ harness: 'claude-code', sessionId, agentId: 'root' }) } : { status: 'missing', coverage: 'none' } },
    labels: [], observations: [{ status: 'succeeded', provenance: 'harness-reported', evidenceDigest: digest(nativeResult) }] }],
    pairs: [{ state: 'ready', reasonCode: null }], schemaVersion: 3, pairCount: 1,
    cacheExists: optIn, cacheCount: optIn ? 0 : null, fixtureUnchanged: true, minimizedLedger: true,
    server: { helloRequests: 1, messageRequests: 2, tokenRequests: 0, readRequested: true, resultMatched: true,
      completed: true, unexpectedRequest: false, boundedFailure: 'none' } };
}
test('generated-settings verifier accepts capture-off and explicitly selected summary evidence', () => {
  for (const optIn of [false, true]) assert.ok(evaluateClaudeSetupRun(validEvidence(optIn)).every(row => row.passed));
});

for (const [name, mutate] of [
  ['inherited deployment masking ignored settings', v => { v.childEnv.REFLEXMESH_DB = '/old-ledger'; }],
  ['test wrapper substituted for production hook', v => { v.settings.hooks.Stop[0].hooks[0].args = ['/test-wrapper.mjs']; }],
  ['permission rules added to generated fragment', v => { v.settings.permissions = { allow: ['Read'] }; }],
  ['remote provider configuration', v => { v.settings.env.REFLEXMESH_ALLOW_REMOTE = 'true'; }],
  ['capture enabled despite default mode', v => { v.settings.env.REFLEXMESH_INTENT_MODE = 'explicit-summary'; }],
  ['foreign final session', v => { v.stdout = v.stdout.replace('"type":"result","session_id":"synthetic-session"', '"type":"result","session_id":"foreign"'); }],
  ['foreign native-result session', v => { v.stdout = v.stdout.replace('"type":"user","session_id":"synthetic-session"', '"type":"user","session_id":"foreign"'); }],
  ['wrong outcome digest', v => { v.records[0].observations[0].evidenceDigest = digest('wrong'); }],
  ['false provenance upgrade', v => { v.records[0].observations[0].provenance = 'test-oracle'; }],
  ['unexpected cache in off mode', v => { v.cacheExists = true; v.cacheCount = 0; }],
  ['nonempty opt-in cache at exit', v => { Object.assign(v, validEvidence(true)); v.cacheCount = 1; }],
  ['foreign opt-in summary', v => { Object.assign(v, validEvidence(true)); v.records[0].evidence.taskEvidence.summaryDigest = digest('wrong'); }],
  ['ambiguous pairing', v => { v.pairs[0] = { state: 'blocked', reasonCode: 'duplicate_pre' }; }],
  ['observer stderr failure despite zero exit', v => { v.stdout = v.stdout.replace('"stderr":""', '"stderr":"ReflexMesh task observation unavailable"'); }],
  ['unknown hook warning', v => { v.stdout = v.stdout.replace('"stderr":""', '"stderr":"other warning"'); }],
  ['nonzero hook response', v => { v.stdout = v.stdout.replace('"exit_code":0', '"exit_code":1'); }],
  ['failed native result disguised as success', v => { v.stdout = v.stdout.replace('"type":"tool_result"', '"type":"tool_result","is_error":true'); }],
  ['final result before hooks complete', v => { const lines = v.stdout.split('\n'); lines.unshift(lines.pop()); v.stdout = lines.join('\n'); }],
  ['malformed JSONL', v => { v.stdout += '\nnot-json'; }],
  ['new truth label', v => { v.records[0].labels.push({}); }],
  ['raw ledger content', v => { v.minimizedLedger = false; }],
  ['unexpected transport request', v => { v.server.messageRequests++; }],
]) test(`setup verifier rejects ${name}`, () => {
  const value = validEvidence(); mutate(value);
  assert.ok(evaluateClaudeSetupRun(value).some(row => !row.passed));
});

test('only the known Node SQLite startup warning is compatible with otherwise successful hooks', () => {
  const value = validEvidence();
  const stream = value.stdout.split('\n').map(JSON.parse);
  for (const item of stream.filter(item => item.subtype === 'hook_response')) item.stderr =
    '(node:123) ExperimentalWarning: SQLite is an experimental feature and might change at any time\n'
    + '(Use `node --trace-warnings ...` to show where the warning was created)\n';
  value.stdout = stream.map(JSON.stringify).join('\n');
  assert.ok(evaluateClaudeSetupRun(value).every(row => row.passed));
});

function workspace(t) {
  const root = mkdtempSync(join(tmpdir(), 'reflexmesh-setup-probe-test-'));
  const canary = join(root, 'unrelated.txt'); writeFileSync(canary, 'preserve');
  t.after(() => {
    const target = realpathSync(root);
    assert.equal(dirname(target), realpathSync(tmpdir()));
    assert.ok(basename(target).startsWith('reflexmesh-setup-probe-test-'));
    rmSync(target, { recursive: true, force: true });
  });
  return { root, canary, deps: { platform: 'win32', systemTemp: root, ancestorCheck: () => true,
    managedCheck: async () => true, doctor: async argv => ({ exitCode: 0, report: { setup: { settings: createClaudeSettings({
      dbPath: argv[argv.indexOf('--db') + 1], tenantId: 'synthetic-setup-probe', scope: 'setup-capture-off',
      intentDbPath: argv[argv.indexOf('--intent-db') + 1] }) } } }) } };
}

test('doctor failure refuses the host session and retains unrelated files', async t => {
  const f = workspace(t); let calls = 0, directory;
  const report = await runClaudeSetupScenario('unused', 'capture-off', 1000, { ...f.deps,
    managedCheck: async (env, dir) => { directory = dir; return true; },
    doctor: async () => ({ exitCode: 1 }), runHost: async () => { calls++; throw new Error('must not start'); } });
  assert.equal(report.reason, 'doctor_prerequisites_failed');
  assert.equal(calls, 0); assert.equal(existsSync(directory), false);
  assert.equal(readFileSync(f.canary, 'utf8'), 'preserve');
});

for (const kind of ['timeout', 'stdout_limit', 'ignored_hooks']) test(`${kind} cannot pass and closes the isolated server`, async t => {
  const f = workspace(t); let directory, endpoint;
  const report = await runClaudeSetupScenario('unused', 'capture-off', 1000, { ...f.deps,
    runHost: async (exe, args, options) => {
      directory = options.cwd; endpoint = options.env.ANTHROPIC_BASE_URL;
      assert.equal(Object.keys(options.env).some(name => /^REFLEXMESH_/i.test(name)), false);
      const settings = JSON.parse(readFileSync(args[args.indexOf('--settings') + 1], 'utf8'));
      assert.equal(settings.env.REFLEXMESH_INTENT_MODE, 'off');
      assert.ok(settings.hooks.PreToolUse[0].hooks[0].args[0].endsWith('claude-task-hook.mjs'));
      return kind === 'ignored_hooks' ? { ok: true, stdout: validEvidence().stdout }
        : { ok: false, kind, stderr: 'private failure details' };
    } });
  assert.equal(report.status, 'failed');
  assert.equal(report.reason, { timeout: 'host_timeout', stdout_limit: 'host_stdout_limit_exceeded', ignored_hooks: 'probe_assertion_failed' }[kind]);
  assert.equal(JSON.stringify(report).includes('private'), false);
  assert.equal(existsSync(directory), false);
  assert.equal(readFileSync(f.canary, 'utf8'), 'preserve');
  await assert.rejects(fetch(endpoint, { signal: AbortSignal.timeout(1000) }));
});

test('help distinguishes static doctor from opt-in actual host and invalid options are redacted', async () => {
  let text = ''; const output = { write: value => { text += value; } };
  assert.equal(await main(['--help'], output), 0);
  assert.match(text, /doctor:claude itself never starts a host/);
  assert.match(text, /synthetic localhost/);
  text = '';
  assert.equal(await main(['--secret', 'private-input'], output), 1);
  assert.equal(JSON.parse(text).reason, 'invalid_options'); assert.equal(text.includes('private'), false);
  const missing = await runClaudeSetupProbe({ claudeCommand: join(tmpdir(), 'no-private-claude.exe') });
  assert.equal(missing.reason, 'host_command_not_found');
  assert.equal(JSON.stringify(missing).includes('private'), false);
});

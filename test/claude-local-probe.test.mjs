import assert from 'node:assert/strict';
import test from 'node:test';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { localEnvironment, localSettings, hookCommand, ancestorContextAbsent, managedConfigurationAbsent,
  evaluateLocalRun, runClaudeLocalProbe, runLocalScenario, main } from '../scripts/claude-local-probe.mjs';
import { digest } from '../adapters/sqlite-kernel.mjs';
import { eventKey } from '../adapters/durable-mesh.mjs';

test('local environment allowlists OS prerequisites and rejects inherited credentials, routing and code loaders', () => {
  const env = localEnvironment({ Path: 'fixture-path', SystemRoot: 'fixture-system', USERPROFILE: 'private-home',
    ANTHROPIC_API_KEY: 'private-key', ANTHROPIC_AUTH_TOKEN: 'private-token', ANTHROPIC_BASE_URL: 'https://remote.invalid',
    NODE_OPTIONS: '--import private-code', HTTP_PROXY: 'private-proxy', CLAUDE_CODE_USE_VERTEX: '1',
    OTEL_EXPORTER_OTLP_ENDPOINT: 'private-telemetry', REFLEXMESH_PROVIDER: 'jev', TYPESAFE_API_KEY: 'private-jev' },
  { directory: '/fixture', baseUrl: 'http://127.0.0.1:3210', token: 'synthetic-only', scenario: 'single-read' });
  assert.equal(env.PATH, 'fixture-path');
  assert.equal(env.SystemRoot, 'fixture-system');
  assert.equal(env.ANTHROPIC_API_KEY, 'synthetic-only');
  assert.equal(env.ANTHROPIC_BASE_URL, 'http://127.0.0.1:3210');
  assert.equal(env.REFLEXMESH_PROVIDER, 'abstain');
  assert.equal(env.REFLEXMESH_ALLOW_REMOTE, 'false');
  assert.equal(env.CLAUDE_CODE_MAX_RETRIES, '0');
  assert.equal(env.ANTHROPIC_CONFIG_DIR, join('/fixture', 'anthropic-config'));
  assert.equal(env.CLAUDE_CODE_PLUGIN_CACHE_DIR, join('/fixture', 'plugins'));
  assert.equal(JSON.stringify(env).includes('private-'), false);
});

test('fixture hook command quotes paths and rejects Windows shell expansion characters', () => {
  assert.equal(hookCommand(['C:\\Program Files\\node.exe', 'C:\\临时\\hook.mjs'], 'win32'),
    '"C:\\Program Files\\node.exe" "C:\\临时\\hook.mjs"');
  for (const bad of ['%TEMP%', '$env:TOKEN', 'x\ny', 'x&y', 'x`y', 'x"y'])
    assert.throws(() => hookCommand(['node', bad], 'win32'), /unsafe_hook_path/);
  assert.equal(hookCommand(["a'b"], 'linux'), "'a'\\''b'");
  const settings = localSettings('fixed-node-command');
  assert.equal(settings.autoMemoryEnabled, false);
  assert.deepEqual(settings.claudeMdExcludes, ['**']);
  assert.deepEqual(Object.keys(settings.hooks), ['UserPromptSubmit','PreToolUse','PostToolUse','PostToolUseFailure','Stop','StopFailure','SessionEnd']);
  assert.equal(settings.hooks.PreToolUse[0].hooks.length, 1); // One wrapper owns observer and capture ordering.
  assert.equal(JSON.stringify(settings).includes('bypassPermissions'), false);
});

const missing = () => { const error = new Error('missing'); error.code = 'ENOENT'; throw error; };
test('ancestor gate checks existence only and rejects instructions, links and unreadable locations', () => {
  const root = join(tmpdir(), 'synthetic-gate');
  assert.equal(ancestorContextAbsent(root, missing), true);
  for (const candidate of ['CLAUDE.md', 'CLAUDE.local.md', 'AGENTS.md', '.claude']) {
    assert.equal(ancestorContextAbsent(root, path => path.endsWith(candidate) ? {} : missing()), false);
  }
  assert.equal(ancestorContextAbsent(root, () => { throw new Error('private inaccessible path'); }), false);
});

test('managed gate rejects existing policy, uncertain registry and unsupported platforms before a host starts', async () => {
  let checks = 0;
  const env = { SystemRoot: '/synthetic/windows' };
  const dependencies = { platform: 'win32', programFiles: '/synthetic/programs',
    stat: path => path.endsWith('powershell.exe') ? { isFile: () => true } : missing(),
    run: async (exe, args, options) => { checks++; assert.ok(args.includes('-NoProfile'));
      assert.ok(args.includes('-NonInteractive')); assert.deepEqual(options.env, env); return { ok: true, stdout: 'absent' }; } };
  assert.equal(await managedConfigurationAbsent(env, '/synthetic', dependencies), true);
  assert.equal(checks, 1);
  assert.equal(await managedConfigurationAbsent(env, '/synthetic', { ...dependencies, stat: () => ({ isFile: () => true }) }), false);
  assert.equal(checks, 1);
  assert.equal(await managedConfigurationAbsent(env, '/synthetic', { ...dependencies, run: async () => ({ ok: false }) }), false);
  assert.equal(await managedConfigurationAbsent(env, '/synthetic', { ...dependencies, run: async () => ({ ok: true, stdout: 'private policy' }) }), false);
  assert.equal(await managedConfigurationAbsent(env, '/synthetic', { ...dependencies, platform: 'linux' }), false);
});

function validEvidence(negative = false) {
  const scenario = negative ? 'duplicate-pre' : 'single-read', fixture = join(tmpdir(), 'synthetic-no-read.txt');
  const scope = { harness: 'claude-code', sessionId: 'synthetic-session', agentId: 'root' };
  const callId = 'reflexmesh_fixture_read', callDigest = digest('call'), actionDigest = digest('action');
  const evidenceDigest = digest('tool-result'), summaryDigest = digest('Read only the isolated synthetic fixture; do not change files.');
  const receipt = event => ({ event, pid: 1, ...scope, deliveries: 1, unavailable: 0, abstained: true,
    cacheEmptyAfterStop: null, summaryDigest: null });
  const receipts = [
    { ...receipt('UserPromptSubmit'), summaryDigest, pid: 1 },
    { ...receipt('PreToolUse'), callId, callDigest, actionDigest, pid: 2, deliveries: negative ? 2 : 1, unavailable: negative ? 1 : 0 },
    { ...receipt('PostToolUse'), callId, callDigest, actionDigest, evidenceDigest, pid: 3, unavailable: negative ? 1 : 0 },
    { ...receipt('Stop'), cacheEmptyAfterStop: true, pid: 4 },
  ];
  const key = eventKey({ tenantId: 'synthetic-local-probe', source: `reflexmesh:${scenario}:claude-code`,
    id: digest([scope.sessionId, scope.agentId, callId, 'before']) });
  return { scenario, fixture, receipts, schemaVersion: 3, pairCount: 1, fixtureUnchanged: true, minimizedLedger: true,
    stdout: [ ...['UserPromptSubmit','PreToolUse','PostToolUse','Stop'].flatMap(event => [
      { type: 'system', subtype: 'hook_started', hook_id: event, hook_event: event, session_id: scope.sessionId },
      { type: 'system', subtype: 'hook_response', hook_id: event, hook_event: event, session_id: scope.sessionId, exit_code: 0, outcome: 'success' }]),
      { type: 'assistant', session_id: scope.sessionId, message: { content: [{ type: 'tool_use', id: callId, name: 'Read', input: { file_path: fixture } }] } },
      { type: 'result', session_id: scope.sessionId, result: 'REFLEXMESH_CLAUDE_LOCAL_OK', is_error: false, subtype: 'success' } ].map(JSON.stringify).join('\n'),
    records: [{ key, state: 'completed', evidence: { mode: 'shadow', actionDigest,
      binding: { providerId: 'abstain', modelId: 'not-configured' },
      taskEvidence: { status: 'ready', source: 'claude-explicit-summary', summaryDigest, scopeDigest: digest(scope) } },
    labels: [], observations: negative ? [] : [{ status: 'succeeded', provenance: 'harness-reported', evidenceDigest }] }],
    pairs: [{ state: negative ? 'blocked' : 'ready', reasonCode: negative ? 'duplicate_pre' : null }],
    server: { helloRequests: 1, messageRequests: 2, tokenRequests: 0, readRequested: true, resultMatched: true,
      completed: true, unexpectedRequest: false, boundedFailure: 'none' } };
}
test('receipt verifier accepts complete synthetic positive and deliberately duplicated observer evidence', () => {
  for (const negative of [false, true]) assert.ok(evaluateLocalRun(validEvidence(negative)).every(row => row.passed));
});

for (const [name, mutate] of [
  ['bare mode with no hooks', v => { v.receipts = []; v.records = []; v.pairs = []; v.pairCount = 0; }],
  ['wrong call association', v => { v.receipts[2].callDigest = digest('other'); }],
  ['foreign prompt and Stop sessions', v => { v.receipts[0].sessionId = v.receipts[3].sessionId = 'other-session'; }],
  ['foreign lifecycle agent', v => { v.receipts[3].agentId = 'other-agent'; }],
  ['StopFailure', v => { v.receipts.push({ ...v.receipts[3], event: 'StopFailure' }); }],
  ['SessionEnd clearing before Stop', v => { v.receipts.splice(3, 0, { ...v.receipts[3], event: 'SessionEnd' }); }],
  ['foreign stdout tool identity', v => { v.stdout = v.stdout.replace('"id":"reflexmesh_fixture_read"', '"id":"other-call"'); }],
  ['foreign stdout final session', v => { v.stdout = v.stdout.replace('"type":"result","session_id":"synthetic-session"', '"type":"result","session_id":"other-session"'); }],
  ['failed host hook response', v => { v.stdout = v.stdout.replace('"exit_code":0', '"exit_code":1'); }],
  ['host hook error outcome', v => { v.stdout = v.stdout.replace('"outcome":"success"', '"outcome":"error"'); }],
  ['unmatched host hook response', v => { v.stdout = v.stdout.replace('"hook_id":"UserPromptSubmit"', '"hook_id":"unmatched"'); }],
  ['corrupt stdout JSONL', v => { v.stdout += '\nnot-json'; }],
  ['wrong task summary', v => { v.records[0].evidence.taskEvidence.summaryDigest = digest('other'); }],
  ['wrong result body', v => { v.records[0].observations[0].evidenceDigest = digest('other'); }],
  ['model-reported source upgrade', v => { v.records[0].observations[0].provenance = 'model-reported'; }],
  ['Stop did not clear the cache', v => { v.receipts[3].cacheEmptyAfterStop = false; }],
  ['nonzero-style result disguised as success', v => { v.stdout = v.stdout.replace('"is_error":false', '"is_error":true'); }],
  ['extra local request', v => { v.server.messageRequests++; }],
  ['unexpected handshake', v => { v.server.helloRequests++; }],
  ['fixture changed', v => { v.fixtureUnchanged = false; }],
  ['raw content retained', v => { v.minimizedLedger = false; }],
  ['new truth label', v => { v.records[0].labels.push({}); }],
]) test(`verifier rejects ${name}`, () => {
  const input = validEvidence(); mutate(input);
  assert.ok(evaluateLocalRun(input).some(row => !row.passed));
});

test('help is explicit about installed version, local synthetic transport and policy preflight', async () => {
  let output = '';
  assert.equal(await main(['--help'], { write: text => { output += text; } }), 0);
  assert.match(output, /2\.1\.263/);
  assert.match(output, /not model inference/);
  assert.match(output, /never edits user settings/);
});

test('missing or unsupported host and malformed options fail without any model call or raw input echo', async () => {
  const absent = await runClaudeLocalProbe({ claudeCommand: join(tmpdir(), 'nonexistent-private-claude-command.exe') });
  assert.equal(absent.reason, 'host_command_not_found');
  assert.equal(JSON.stringify(absent).includes('private'), false);
  const wrongVersion = await runClaudeLocalProbe({ claudeCommand: process.execPath });
  assert.equal(wrongVersion.reason, 'unsupported_host_version');
  let output = '';
  const exit = await main(['--private-option', 'private-key'], { write: text => { output += text; } });
  assert.equal(exit, 1);
  assert.equal(JSON.parse(output).reason, 'invalid_options');
  assert.equal(output.includes('private'), false);
});

function isolatedScenario(t) {
  const root = mkdtempSync(join(tmpdir(), 'reflexmesh-probe-test-'));
  const canary = join(root, 'unrelated.txt');
  writeFileSync(canary, 'preserve');
  t.after(() => {
    const target = realpathSync(root);
    assert.equal(dirname(target), realpathSync(tmpdir()));
    assert.ok(basename(target).startsWith('reflexmesh-probe-test-'));
    rmSync(target, { recursive: true, force: true });
  });
  return { root, canary, options: { platform: 'win32', systemTemp: root, ancestorCheck: () => true, managedCheck: async () => true } };
}

test('ancestor and managed refusal never start a host; created preflight directory is cleaned', async t => {
  const f = isolatedScenario(t);
  let calls = 0, created;
  const run = async () => { calls++; throw new Error('must not start'); };
  const ancestor = await runLocalScenario('unused', 'single-read', 1000, run, { ...f.options, ancestorCheck: () => false });
  assert.equal(ancestor.reason, 'ambient_context_unverified');
  const managed = await runLocalScenario('unused', 'single-read', 1000, run, {
    ...f.options, managedCheck: async (env, directory) => { created = directory; return false; } });
  assert.equal(managed.reason, 'managed_configuration_unverified');
  assert.equal(calls, 0);
  assert.equal(existsSync(created), false);
  assert.equal(readFileSync(f.canary, 'utf8'), 'preserve');
});

for (const kind of ['timeout', 'stdout_limit', 'spawn_error', 'corrupt_receipts']) {
  test(`scenario ${kind} closes local service and removes only its own temporary directory`, async t => {
    const f = isolatedScenario(t);
    let directory, endpoint;
    const result = await runLocalScenario('unused', 'single-read', 1000, async (exe, args, options) => {
      directory = options.cwd; endpoint = options.env.ANTHROPIC_BASE_URL;
      if (kind === 'corrupt_receipts') {
        writeFileSync(options.env.REFLEXMESH_LOCAL_RECEIPTS, '{}\nprivate-corruption\n');
        return { ok: true, stdout: '', stderr: '' };
      }
      return { ok: false, kind, stdout: 'private output', stderr: 'private error' };
    }, f.options);
    assert.equal(result.status, 'failed');
    assert.equal(result.reason, { timeout: 'host_timeout', stdout_limit: 'host_stdout_limit_exceeded',
      spawn_error: 'host_spawn_failed', corrupt_receipts: 'probe_execution_failed' }[kind]);
    assert.equal(JSON.stringify(result).includes('private'), false);
    assert.equal(existsSync(directory), false);
    assert.equal(readFileSync(f.canary, 'utf8'), 'preserve');
    await assert.rejects(fetch(endpoint, { signal: AbortSignal.timeout(1000) }));
  });
}

test('cleanup errors retain a fixed failure result rather than a successful host result', async t => {
  const f = isolatedScenario(t);
  const result = await runLocalScenario('unused', 'single-read', 1000,
    async () => ({ ok: false, kind: 'timeout' }), { ...f.options, remove: (target, options) => {
      assert.equal(dirname(target), realpathSync(f.root));
      assert.ok(basename(target).startsWith('reflexmesh-claude-local-'));
      rmSync(target, options); // Simulate failure without leaving artifacts on CI.
      throw new Error('private cleanup detail');
    } });
  assert.equal(result.status, 'failed');
  assert.equal(result.reason, 'probe_cleanup_failed');
  assert.equal(JSON.stringify(result).includes('private'), false);
});

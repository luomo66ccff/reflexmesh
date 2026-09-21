#!/usr/bin/env node
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { SqliteKernel, digest } from '../adapters/sqlite-kernel.mjs';
import { eventKey } from '../adapters/durable-mesh.mjs';
import { isDirectRun } from '../adapters/direct-run.mjs';
import { resolveExecutable, runBounded, evaluateClaudeJsonl, processFailureReason } from './real-host-compat.mjs';
import { startClaudeFixture } from './claude-loopback-server.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PREFIX = 'reflexmesh-claude-local-';
// A CLI-recognized wire label, served exclusively by our synthetic localhost fixture.
const MODEL = 'claude-sonnet-4-6';
const MARKER = 'REFLEXMESH_CLAUDE_LOCAL_OK';
const SUMMARY = 'Read only the isolated synthetic fixture; do not change files.';
const VERSION = '2.1.263';
const OS_ENV = ['PATH', 'SystemRoot', 'WINDIR', 'ComSpec', 'PATHEXT', 'TEMP', 'TMP'];
const row = (name, passed) => ({ name, passed: passed === true });
const lines = text => text.split(/\r?\n/).filter(Boolean).map(line => {
  const value = JSON.parse(line);
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid_jsonl_record');
  return value;
});

/** Do not inherit credentials, routing, proxies, NODE_OPTIONS, plugins or profile pointers. */
export function localEnvironment(parent, { directory, baseUrl, token, scenario }) {
  const env = {};
  for (const name of OS_ENV) {
    const key = Object.keys(parent).find(key => key.toLowerCase() === name.toLowerCase());
    if (key) env[name] = parent[key];
  }
  return { ...env, ANTHROPIC_BASE_URL: baseUrl, ANTHROPIC_API_KEY: token,
    CLAUDE_CONFIG_DIR: join(directory, 'config'), ANTHROPIC_CONFIG_DIR: join(directory, 'anthropic-config'),
    CLAUDE_CODE_PLUGIN_CACHE_DIR: join(directory, 'plugins'), CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1',
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    CLAUDE_CODE_DISABLE_OFFICIAL_MARKETPLACE_AUTOINSTALL: '1', CLAUDE_CODE_DISABLE_TERMINAL_TITLE: '1',
    CLAUDE_CODE_DISABLE_NONSTREAMING_FALLBACK: '1', CLAUDE_CODE_MAX_RETRIES: '0',
    DISABLE_TELEMETRY: '1', DISABLE_ERROR_REPORTING: '1', DISABLE_UPDATES: '1',
    REFLEXMESH_PROVIDER: 'abstain', REFLEXMESH_ALLOW_REMOTE: 'false',
    REFLEXMESH_DB: join(directory, 'ledger.sqlite'), REFLEXMESH_INTENT_DB: join(directory, 'intent.sqlite'),
    REFLEXMESH_INTENT_MODE: 'explicit-summary', REFLEXMESH_TASK_EVIDENCE: 'true',
    REFLEXMESH_TENANT: 'synthetic-local-probe', REFLEXMESH_SCOPE: scenario,
    REFLEXMESH_LOCAL_SCENARIO: scenario, REFLEXMESH_LOCAL_FIXTURE: join(directory, 'fixture.txt'),
    REFLEXMESH_LOCAL_RECEIPTS: join(directory, 'hook-receipts.jsonl') };
}

export function hookCommand(paths, platform = process.platform) {
  if (platform === 'win32') {
    if (paths.some(path => /[\r\n"%!^&|<>$`]/u.test(path))) throw new Error('unsafe_hook_path');
    return paths.map(path => `"${path}"`).join(' ');
  }
  return paths.map(path => `'${path.replaceAll("'", "'\\''")}'`).join(' ');
}
export function localSettings(command) {
  const hook = { type: 'command', command, timeout: 10 };
  return { autoMemoryEnabled: false, claudeMdExcludes: ['**'], hooks: Object.fromEntries(['UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'PostToolUseFailure',
    'Stop', 'StopFailure', 'SessionEnd'].map(event => [event, [{ ...(event.includes('ToolUse') ? { matcher: '*' } : {}), hooks: [hook] }]])) };
}

function absent(path, stat = lstatSync) {
  try { stat(path); return false; } catch (error) { return error.code === 'ENOENT'; }
}
export function ancestorContextAbsent(directory, stat = lstatSync) {
  for (let current = resolve(directory);; current = dirname(current)) {
    if (['CLAUDE.md', 'CLAUDE.local.md', 'AGENTS.md', '.claude'].some(name => !absent(join(current, name), stat))) return false;
    if (dirname(current) === current) return true;
  }
}

export async function managedConfigurationAbsent(env, directory, {
  platform = process.platform, programFiles = process.env.ProgramFiles, stat = lstatSync, run = runBounded,
} = {}) {
  // Conservative preflight, not a policy override or an OS sandbox.
  if (platform !== 'win32') return false; // Other platform policy stores are not validated yet.
  if (!programFiles || !absent(join(programFiles, 'ClaudeCode'), stat)) return false;
  const shell = join(env.SystemRoot ?? '', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  try { if (!stat(shell).isFile()) return false; } catch { return false; }
  const script = "$ErrorActionPreference='Stop'; try { if ((Test-Path -LiteralPath 'Registry::HKEY_LOCAL_MACHINE\\SOFTWARE\\Policies\\ClaudeCode') -or (Test-Path -LiteralPath 'Registry::HKEY_CURRENT_USER\\SOFTWARE\\Policies\\ClaudeCode')) { exit 2 }; [Console]::Write('absent') } catch { exit 3 }";
  const checked = await run(shell, ['-NoProfile', '-NonInteractive', '-Command', script], {
    cwd: directory, env, timeoutMs: 10000, stdoutLimitBytes: 1024, stderrLimitBytes: 1024 });
  return checked.ok && checked.stdout === 'absent';
}

export function evaluateLocalRun({ stdout, receipts, records, pairs, server, fixture, scenario, schemaVersion, pairCount, fixtureUnchanged, minimizedLedger }) {
  let stream;
  try { stream = lines(stdout); } catch { return [row('well_formed_host_stream', false)]; }
  const events = name => receipts.filter(receipt => receipt.event === name);
  const pre = events('PreToolUse')[0], post = events('PostToolUse')[0], prompt = events('UserPromptSubmit')[0], stop = events('Stop')[0];
  const record = records[0], pair = pairs[0], negative = scenario === 'duplicate-pre';
  const identityMatches = pre && post && pre.sessionId === post.sessionId && pre.agentId === post.agentId
    && pre.callId === post.callId && pre.callDigest === post.callDigest;
  const key = pre && eventKey({ tenantId: 'synthetic-local-probe', source: `reflexmesh:${scenario}:claude-code`,
    id: digest([pre.sessionId, pre.agentId, pre.callId, 'before']) });
  const normalized = evaluateClaudeJsonl(stdout, fixture, MARKER);
  const result = stream.filter(record => record.type === 'result');
  const toolMessages = stream.filter(record => record.type === 'assistant' && Array.isArray(record.message?.content))
    .flatMap(record => record.message.content.filter(block => block?.type === 'tool_use').map(block => ({ record, block })));
  const lifecycle = ['UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'Stop'];
  const hookStream = stream.filter(record => record.type === 'system' && record.subtype?.startsWith('hook_'));
  const validHookStream = hookStream.length === 8 && lifecycle.every((event, index) => {
    const start = hookStream[index * 2], response = hookStream[index * 2 + 1];
    return start?.subtype === 'hook_started' && response?.subtype === 'hook_response'
      && start.hook_event === event && response.hook_event === event
      && typeof start.hook_id === 'string' && start.hook_id.length > 0 && start.hook_id === response.hook_id
      && start.session_id === pre?.sessionId && response.session_id === pre?.sessionId
      && response.exit_code === 0 && response.outcome === 'success';
  });
  const task = record?.evidence?.taskEvidence;
  return [
    row('structured_single_fixture_read', normalized.passed),
    row('successful_final_result', result.length === 1 && result[0].is_error === false && result[0].subtype === 'success'),
    row('two_local_messages_and_matching_read_result', server.messageRequests === 2 && server.readRequested
      && server.resultMatched && server.completed && !server.unexpectedRequest && server.boundedFailure === 'none'),
    row('single_explicit_connectivity_handshake', server.helloRequests === 1 && server.tokenRequests === 0),
    row('actual_prompt_pre_post_stop_hooks', ['UserPromptSubmit','PreToolUse','PostToolUse','Stop'].every(name => events(name).length === 1)
      && events('PostToolUseFailure').length === 0 && events('StopFailure').length === 0
      && new Set([prompt?.pid, pre?.pid, post?.pid, stop?.pid]).size === 4),
    row('ordered_hook_lifecycle', receipts.indexOf(prompt) < receipts.indexOf(pre) && receipts.indexOf(pre) < receipts.indexOf(post)
      && receipts.indexOf(post) < receipts.indexOf(stop)
      && events('SessionEnd').every(receipt => receipts.indexOf(receipt) > receipts.indexOf(stop))),
    row('one_host_session_and_agent', typeof pre?.sessionId === 'string' && pre.sessionId.length > 0 && pre.agentId === 'root'
      && receipts.every(receipt => [...lifecycle, 'SessionEnd'].includes(receipt.event)
        && receipt.sessionId === pre.sessionId && receipt.agentId === pre.agentId)
      && result.length === 1 && result[0].session_id === pre.sessionId),
    row('successful_ordered_host_hook_responses', validHookStream),
    row('same_host_call_identity', Boolean(identityMatches) && pre.callId === 'reflexmesh_fixture_read'
      && toolMessages.length === 1 && toolMessages[0].block.id === pre.callId && toolMessages[0].record.session_id === pre.sessionId),
    row('one_exact_ledger_key', records.length === 1 && record?.key === key),
    row('schema_three_one_pair', schemaVersion === 3 && pairCount === 1),
    row('completed_shadow_abstain_binding', record?.state === 'completed' && record?.evidence?.mode === 'shadow'
      && record?.evidence?.binding?.providerId === 'abstain' && record?.evidence?.binding?.modelId === 'not-configured'),
    row('exact_task_summary_and_scope', task?.status === 'ready' && task?.source === 'claude-explicit-summary'
      && task?.summaryDigest === digest(SUMMARY) && prompt?.summaryDigest === digest(SUMMARY)
      && Boolean(pre) && task?.scopeDigest === digest({ harness: 'claude-code', sessionId: pre.sessionId, agentId: pre.agentId })),
    row('exact_action_digest', typeof pre?.actionDigest === 'string' && record?.evidence?.actionDigest === pre.actionDigest && pre.actionDigest === post?.actionDigest),
    row('durable_pairing_expected_state', pairs.length === 1 && pair?.state === (negative ? 'blocked' : 'ready')
      && pair?.reasonCode === (negative ? 'duplicate_pre' : null)),
    row('exact_outcome_or_rejected_duplicate', negative ? record?.observations?.length === 0 : record?.observations?.length === 1
      && record.observations[0].status === 'succeeded' && record.observations[0].provenance === 'harness-reported'
      && record.observations[0].evidenceDigest === post?.evidenceDigest),
    row('zero_independent_labels', record?.labels?.length === 0),
    row('stop_itself_cleared_task_cache', stop?.cacheEmptyAfterStop === true),
    row('fixture_content_unchanged', fixtureUnchanged === true),
    row('raw_summary_and_tool_output_not_persisted', minimizedLedger === true),
    row('observer_responses_always_abstain', receipts.length >= 4 && receipts.every(receipt => receipt.abstained === true)),
    row('expected_observer_delivery_and_diagnostics', pre?.deliveries === (negative ? 2 : 1)
      && pre?.unavailable === (negative ? 1 : 0) && post?.unavailable === (negative ? 1 : 0)
      && receipts.filter(receipt => !['PreToolUse','PostToolUse'].includes(receipt.event)).every(receipt => receipt.unavailable === 0)),
  ];
}

// Dependency seams exercise refusal/cleanup without an installed CLI or model.
export async function runLocalScenario(executable, scenario, timeoutMs, runHost, {
  platform = process.platform, systemTemp = process.env.SystemRoot && join(process.env.SystemRoot, 'Temp'),
  ancestorCheck = ancestorContextAbsent, managedCheck = managedConfigurationAbsent, remove = rmSync,
} = {}) {
  let directory, temporaryRoot, service;
  const result = { scenario, status: 'failed', reason: 'probe_execution_failed', assertions: [] };
  try {
    // User Temp is commonly beneath an existing ~/.claude directory. Never read
    // or clear it: use the Windows system Temp only if all ancestors are clean.
    if (platform !== 'win32' || !systemTemp) { result.reason = 'unsupported_host_platform'; return result; }
    temporaryRoot = realpathSync(systemTemp);
    if (!ancestorCheck(temporaryRoot)) { result.reason = 'ambient_context_unverified'; return result; }
    directory = mkdtempSync(join(temporaryRoot, PREFIX));
    const env = localEnvironment(process.env, { directory, baseUrl: 'http://127.0.0.1:1', token: 'synthetic', scenario });
    mkdirSync(env.CLAUDE_CONFIG_DIR, { mode: 0o700 });
    mkdirSync(env.ANTHROPIC_CONFIG_DIR, { mode: 0o700 });
    mkdirSync(env.CLAUDE_CODE_PLUGIN_CACHE_DIR, { mode: 0o700 });
    if (!await managedCheck(env, directory)) { result.reason = 'managed_configuration_unverified'; return result; }
    const token = `synthetic-${randomUUID()}`, fixtureText = `LOCAL_READ_PROOF_${randomUUID()}`;
    writeFileSync(env.REFLEXMESH_LOCAL_FIXTURE, fixtureText + '\n', { mode: 0o600 });
    writeFileSync(env.REFLEXMESH_LOCAL_RECEIPTS, '', { mode: 0o600 });
    const settings = join(directory, 'settings.json');
    writeFileSync(settings, JSON.stringify(localSettings(hookCommand([process.execPath, join(ROOT, 'scripts', 'claude-local-hook.mjs')]))), { mode: 0o600 });
    service = await startClaudeFixture({ model: MODEL, fixturePath: env.REFLEXMESH_LOCAL_FIXTURE, fixtureText, token, marker: MARKER });
    env.ANTHROPIC_BASE_URL = service.baseUrl; env.ANTHROPIC_API_KEY = token;
    const args = ['--restricted', '--print', '--output-format', 'stream-json', '--verbose', '--include-hook-events',
      '--no-session-persistence', '--setting-sources', '', '--disable-slash-commands', '--no-chrome', '--settings', settings,
      '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}', '--tools', 'Read', '--allowedTools', 'Read',
      '--permission-mode', 'dontAsk', '--permission-prompts', 'none', '--model', MODEL, '--max-turns', '3',
      '--system-prompt', 'This is a local synthetic transport compatibility test. Use only the supplied Read fixture.',
      `ReflexMesh-Intent: ${SUMMARY}\nRead the isolated fixture at ${JSON.stringify(env.REFLEXMESH_LOCAL_FIXTURE)} once.`];
    const host = await runHost(executable, args, { cwd: directory, env, timeoutMs,
      stdoutLimitBytes: 1024 * 1024, stderrLimitBytes: 65536 });
    result.transport = service.snapshot();
    if (!host.ok) result.reason = processFailureReason(host);
    else {
      const receipts = lines(readFileSync(env.REFLEXMESH_LOCAL_RECEIPTS, 'utf8'));
      let records = [], pairs = [], schemaVersion = null, pairCount = null;
      if (existsSync(env.REFLEXMESH_DB)) {
        const kernel = new SqliteKernel(env.REFLEXMESH_DB, { readOnly: true });
        try {
          records = kernel.listEvidence({ limit: 10 }).items.map(item => ({ key: item.key, ...kernel.inspect(item.key) }));
          pairs = records.map(record => kernel.pairingSnapshot(record.key));
        } finally { kernel.close(); }
        const raw = new DatabaseSync(env.REFLEXMESH_DB, { readOnly: true });
        try {
          schemaVersion = raw.prepare('PRAGMA user_version').get().user_version;
          pairCount = raw.prepare('SELECT count(*) n FROM claude_hook_pairs').get().n;
        } finally { raw.close(); }
      }
      result.assertions = evaluateLocalRun({ stdout: host.stdout, receipts, records, pairs,
        server: service.snapshot(), fixture: env.REFLEXMESH_LOCAL_FIXTURE, scenario, schemaVersion, pairCount,
        fixtureUnchanged: readFileSync(env.REFLEXMESH_LOCAL_FIXTURE, 'utf8') === fixtureText + '\n',
        minimizedLedger: ![SUMMARY, fixtureText, token].some(text => JSON.stringify(records).includes(text)) });
      const passed = result.assertions.every(item => item.passed);
      result.status = passed ? 'passed' : 'failed'; result.reason = passed ? 'local_host_loop_passed' : 'probe_assertion_failed';
    }
  } catch { result.reason = 'probe_execution_failed'; }
  finally {
    try {
      await service?.close();
      if (directory) {
        const target = realpathSync(directory);
        if (dirname(target) !== temporaryRoot || !basename(target).startsWith(PREFIX)) throw new Error('unsafe_cleanup');
        remove(target, { recursive: true, force: true });
      }
    } catch { result.status = 'failed'; result.reason = 'probe_cleanup_failed'; }
  }
  return result;
}

export async function runClaudeLocalProbe({ claudeCommand = 'claude', timeoutMs = 60000 } = {}, { runHost = runBounded } = {}) {
  const report = { schemaVersion: 1, evidenceLevel: 'installed_claude_local_transport', hostVersion: 'unverified',
    modelInference: false, modelTransport: 'loopback_fixture', classification: 'abstain', defaultProfileUsed: false,
    status: 'failed', reason: 'invalid_options', scenarios: [] };
  if (typeof claudeCommand !== 'string' || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 120000) return report;
  const executable = resolveExecutable(claudeCommand, { host: 'claude' });
  if (!executable) return { ...report, reason: 'host_command_not_found' };
  const version = await runBounded(executable, ['--version'], { cwd: ROOT, env: {}, timeoutMs: 10000,
    stdoutLimitBytes: 1024, stderrLimitBytes: 1024 });
  if (!version.ok || version.stdout.trim() !== `${VERSION} (Claude Code)`) return { ...report, reason: 'unsupported_host_version' };
  report.hostVersion = VERSION;
  for (const scenario of ['single-read', 'duplicate-pre']) {
    const result = await runLocalScenario(executable, scenario, timeoutMs, runHost);
    report.scenarios.push(result);
    if (result.status !== 'passed') { report.reason = result.reason; return report; }
  }
  return { ...report, status: 'passed', reason: 'local_host_loops_passed' };
}

export async function main(argv = process.argv.slice(2), output = process.stdout) {
  if (argv.length === 1 && ['--help', '-h'].includes(argv[0])) {
    output.write('Usage: npm run compat:claude-local -- [--claude-command NATIVE_EXECUTABLE]\n'
      + 'Account-free installed Claude Code 2.1.263 / Windows check using local synthetic Messages, not model inference.\n'
      + 'Runs one fixed Read plus a duplicate-observer delivery scenario in separate temporary sessions.\n'
      + 'Requires clean writable Windows system Temp and no managed Claude policy/context; never edits user settings.\n'
      + 'This is not an OS filesystem/network sandbox. See docs/CLAUDE-LOCAL-LOOP.md.\n');
    return 0;
  }
  let options = {}, valid = argv.length === 0 || argv.length === 2 && argv[0] === '--claude-command';
  if (argv.length) options.claudeCommand = argv[1];
  const report = valid ? await runClaudeLocalProbe(options) : { schemaVersion: 1, status: 'failed', reason: 'invalid_options', modelInference: false };
  output.write(JSON.stringify(report) + '\n');
  return report.status === 'passed' ? 0 : 1;
}
if (isDirectRun(import.meta.url)) process.exitCode = await main();

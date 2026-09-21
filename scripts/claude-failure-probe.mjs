#!/usr/bin/env node
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { SqliteKernel, digest } from '../adapters/sqlite-kernel.mjs';
import { eventKey } from '../adapters/durable-mesh.mjs';
import { isDirectRun } from '../adapters/direct-run.mjs';
import { diagnoseClaudeDoctor } from '../adapters/claude-doctor.mjs';
import { localEnvironment, ancestorContextAbsent, managedConfigurationAbsent } from './claude-local-probe.mjs';
import { resolveExecutable, runBounded, processFailureReason } from './real-host-compat.mjs';
import { startClaudeFailureFixture, FAILURE_TOOL, FAILURE_CALLS } from './claude-failure-server.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PREFIX = 'reflexmesh-claude-failure-';
const MODEL = 'claude-sonnet-4-6', MARKER = 'REFLEXMESH_CLAUDE_FAILURE_OK';
export const FAILURE_SUMMARY = 'Run only the two synthetic in-memory outcome fixtures; do not modify user files.';
const row = (name, passed) => ({ name, passed: passed === true });
const EVENTS = { UserPromptSubmit: 1, PreToolUse: 2, PostToolUse: 1, PostToolUseFailure: 1, Stop: 1 };
const ALL_EVENTS = [...Object.keys(EVENTS), 'StopFailure', 'SessionEnd'];
const sqliteWarningOnly = text => typeof text === 'string' && /^(?:\(node:\d+\) ExperimentalWarning: SQLite is an experimental feature and might change at any time\r?\n\(Use `node --trace-warnings \.\.\.` to show where the warning was created\)\r?\n)?$/.test(text);
const DIAGNOSTIC_CODES = new Set(['EACCES', 'EADDRINUSE', 'EADDRNOTAVAIL', 'EPERM', 'EMFILE', 'ENFILE']);
function diagnosticCode(error) {
  let code;
  try { code = error?.code; } catch { return 'unknown'; }
  return DIAGNOSTIC_CODES.has(code) ? code : 'unknown';
}

export function evaluateClaudeFailureRun({ stdout, settings, childEnv, records, pairs, receipts,
  transport, ledger, intent, schemaVersion, pairCount, cacheCount, minimized }) {
  let stream;
  try { stream = stdout.split(/\r?\n/).filter(Boolean).map(JSON.parse);
    if (stream.some(value => !value || typeof value !== 'object' || Array.isArray(value))) throw new Error('invalid');
  } catch { return [row('well_formed_host_stream', false)]; }
  const finals = stream.filter(item => item.type === 'result'), session = finals[0]?.session_id;
  const calls = stream.filter(item => item.type === 'assistant' && Array.isArray(item.message?.content))
    .flatMap(item => item.message.content.filter(block => block?.type === 'tool_use').map(block => ({ item, block })));
  const users = stream.filter(item => item.type === 'user');
  const results = users.flatMap(item => (Array.isArray(item.message?.content) ? item.message.content : [])
    .filter(block => block?.type === 'tool_result').map(block => ({ item, block })));
  const hooks = stream.filter(item => item.type === 'system' && item.subtype?.startsWith('hook_'));
  const starts = hooks.filter(item => item.subtype === 'hook_started');
  const responses = hooks.filter(item => item.subtype === 'hook_response');
  const eventResponses = name => responses.filter(item => item.hook_event === name);
  const eventStarts = name => starts.filter(item => item.hook_event === name);
  const keyFor = id => typeof session === 'string' ? eventKey({ tenantId: 'synthetic-failure-probe', source: 'reflexmesh:mixed-outcomes:claude-code',
    id: digest([session, 'root', id, 'before']) }) : null;
  const recordFor = id => records.find(item => item.key === keyFor(id));
  const resultFor = id => results.find(item => item.block.tool_use_id === id);
  const expectedEnv = { REFLEXMESH_DB: ledger, REFLEXMESH_TENANT: 'synthetic-failure-probe', REFLEXMESH_SCOPE: 'mixed-outcomes',
    REFLEXMESH_PROVIDER: 'abstain', REFLEXMESH_ALLOW_REMOTE: 'false', REFLEXMESH_TASK_EVIDENCE: 'true',
    REFLEXMESH_INTENT_MODE: 'explicit-summary', REFLEXMESH_INTENT_DB: intent };
  const directHooks = settings && Object.keys(settings).sort().join(',') === 'env,hooks'
    && Object.keys(settings.hooks ?? {}).sort().join(',') === [...ALL_EVENTS].sort().join(',')
    && ALL_EVENTS.every(event => {
      const entries = settings.hooks[event], hook = entries?.[0]?.hooks?.[0];
      return entries?.length === 1 && entries[0].hooks?.length === 1 && hook?.type === 'command'
        && hook.command === process.execPath && hook.args?.length === 1
        && hook.args[0] === join(ROOT, 'adapters', 'claude-task-hook.mjs') && hook.timeout === 10
        && Object.keys(hook).sort().join(',') === 'args,command,timeout,type'
        && (event.includes('ToolUse') ? entries[0].matcher === '*' : entries[0].matcher === undefined);
    });
  const lifecycle = hooks.length === 12 && starts.length === 6 && responses.length === 6
    && new Set(starts.map(item => item.hook_id)).size === 6
    && Object.entries(EVENTS).every(([event, count]) => eventStarts(event).length === count && eventResponses(event).length === count)
    && starts.every(start => {
      const matching = responses.filter(end => end.hook_id === start.hook_id);
      const end = matching[0];
      return typeof start.hook_id === 'string' && start.hook_id.length > 0 && matching.length === 1
        && start.session_id === session && end.session_id === session && start.hook_event === end.hook_event
        && end.exit_code === 0 && end.outcome === 'success' && end.stdout?.trim() === '{}'
        && sqliteWarningOnly(end.stderr) && stream.indexOf(start) < stream.indexOf(end);
    });
  const lifecycleOrder = lifecycle
    && eventResponses('UserPromptSubmit').every(prompt => eventStarts('PreToolUse').every(pre => stream.indexOf(prompt) < stream.indexOf(pre)))
    && eventResponses('PreToolUse').every(pre => [...eventStarts('PostToolUse'), ...eventStarts('PostToolUseFailure')].every(post => stream.indexOf(pre) < stream.indexOf(post)))
    && [...eventResponses('PostToolUse'), ...eventResponses('PostToolUseFailure')].every(post => stream.indexOf(post) < stream.indexOf(eventStarts('Stop')[0]))
    && stream.indexOf(eventResponses('Stop')[0]) < stream.indexOf(finals[0]);
  return [
    row('doctor_settings_keep_direct_production_hooks', Boolean(directHooks)),
    row('exact_settings_only_shadow_deployment', Object.keys(settings?.env ?? {}).length === 8
      && Object.entries(expectedEnv).every(([key, value]) => settings.env[key] === value)),
    row('no_inherited_reflexmesh_deployment', Object.keys(childEnv).every(key => !/^REFLEXMESH_/i.test(key))),
    row('one_successful_final_session', finals.length === 1 && finals[0].is_error === false && finals[0].subtype === 'success'
      && finals[0].result?.includes(MARKER) && typeof session === 'string' && session.length > 0),
    row('exact_two_native_calls', calls.length === 2 && FAILURE_CALLS.every(call => {
      const matches = calls.filter(item => item.block.id === call.id);
      return matches.length === 1 && matches[0].item.session_id === session && matches[0].block.name === FAILURE_TOOL
        && JSON.stringify(matches[0].block.input) === JSON.stringify(call.input);
    })),
    row('one_success_one_failure_native_results', results.length === 2 && users.length === 2 && FAILURE_CALLS.every(call => {
      const matches = results.filter(item => item.block.tool_use_id === call.id), result = matches[0];
      return matches.length === 1 && result.item.session_id === session
        && (call.id === 'fixture_fail' ? result.block.is_error === true : [undefined, false].includes(result.block.is_error));
    })),
    row('exact_successful_lifecycle_responses', lifecycle),
    row('prompt_pre_post_stop_final_order', lifecycleOrder),
    row('actual_tool_bodies_overlap', receipts.length === 4 && receipts.slice(0, 2).every((item, index) =>
      item.event === 'entered' && item.active === index + 1) && new Set(receipts.slice(0, 2).map(item => item.mode)).size === 2
      && receipts.every(item => ['ok', 'fail'].includes(item.mode))
      && receipts.slice(2).every((item, index) => item.event === 'exited' && item.active === 1 - index && item.overlapping === true)
      && new Set(receipts.slice(2).map(item => item.mode)).size === 2),
    row('exact_local_transport', transport.helloRequests === 1 && transport.messageRequests === 2
      && transport.resultMatched && transport.completed && transport.boundedFailure === 'none'),
    row('two_exact_ledger_keys', typeof session === 'string' && records.length === 2
      && new Set(records.map(item => item.key)).size === 2 && FAILURE_CALLS.every(call => recordFor(call.id))),
    row('schema_three_two_ready_pairs', schemaVersion === 3 && pairCount === 2 && pairs.length === 2
      && pairs.every(pair => pair?.state === 'ready' && pair.reasonCode === null)),
    row('both_completed_shadow_abstain', records.length === 2 && records.every(item => item.state === 'completed'
      && item.evidence?.mode === 'shadow' && item.evidence?.binding?.providerId === 'abstain'
      && item.evidence?.binding?.modelId === 'not-configured')),
    row('both_exact_current_task_bindings', records.length === 2 && records.every(item => {
      const task = item.evidence?.taskEvidence;
      return typeof session === 'string' && task?.status === 'ready' && task.source === 'claude-explicit-summary' && task.coverage === 'summary-only'
        && task.summaryDigest === digest(FAILURE_SUMMARY)
        && task.scopeDigest === digest({ harness: 'claude-code', sessionId: session, agentId: 'root' });
    })),
    row('per_call_action_digests', FAILURE_CALLS.every(call => recordFor(call.id)?.evidence?.actionDigest === digest({ toolId: FAILURE_TOOL, args: call.input }))),
    row('per_call_outcomes_and_native_content_digests', FAILURE_CALLS.every(call => {
      const observed = recordFor(call.id)?.observations, native = resultFor(call.id)?.block;
      return native && observed?.length === 1 && observed[0].provenance === 'harness-reported'
        && observed[0].status === (call.id === 'fixture_fail' ? 'failed' : 'succeeded')
        && observed[0].evidenceDigest === digest(native.content);
    })),
    row('zero_independent_labels', records.length === 2 && records.every(item => item.labels?.length === 0)),
    row('cache_empty_at_exit', cacheCount === 0),
    row('minimized_ledger', minimized === true),
  ];
}

export async function runClaudeFailureProbe({ claudeCommand = 'claude', timeoutMs = 60000 } = {}, {
  runHost = runBounded, doctor = diagnoseClaudeDoctor, runVersion = runBounded, resolveHost = resolveExecutable,
  platform = process.platform, systemTemp = process.env.SystemRoot && join(process.env.SystemRoot, 'Temp'),
  ancestorCheck = ancestorContextAbsent, managedCheck = managedConfigurationAbsent, remove = rmSync,
  startFixture = startClaudeFailureFixture,
} = {}) {
  const report = { schemaVersion: 1, evidenceLevel: 'installed_claude_mixed_outcomes',
    modelInference: false, modelTransport: 'loopback_fixture', defaultProfileUsed: false,
    hostVersion: 'unverified', status: 'failed', reason: 'probe_execution_failed', assertions: [] };
  let temporaryRoot, directory, service, phase = 'preflight';
  try {
    if (typeof claudeCommand !== 'string' || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 120000) { report.reason = 'invalid_options'; return report; }
    if (platform !== 'win32' || !systemTemp) { report.reason = 'unsupported_host_platform'; return report; }
    const executable = resolveHost(claudeCommand, { host: 'claude' });
    if (!executable) { report.reason = 'host_command_not_found'; return report; }
    const version = await runVersion(executable, ['--version'], { cwd: ROOT, env: {}, timeoutMs: 10000, stdoutLimitBytes: 1024, stderrLimitBytes: 1024 });
    if (!version.ok || version.stdout.trim() !== '2.1.263 (Claude Code)') { report.reason = 'unsupported_host_version'; return report; }
    report.hostVersion = '2.1.263';
    phase = 'isolation_setup';
    temporaryRoot = realpathSync(systemTemp);
    if (!ancestorCheck(temporaryRoot)) { report.reason = 'ambient_context_unverified'; return report; }
    directory = mkdtempSync(join(temporaryRoot, PREFIX));
    const env = localEnvironment(process.env, { directory, baseUrl: 'http://127.0.0.1:1', token: 'synthetic', scenario: 'mixed-outcomes' });
    for (const key of Object.keys(env)) if (/^REFLEXMESH_/i.test(key)) delete env[key];
    for (const key of ['CLAUDE_CONFIG_DIR', 'ANTHROPIC_CONFIG_DIR', 'CLAUDE_CODE_PLUGIN_CACHE_DIR']) mkdirSync(env[key], { mode: 0o700 });
    if (!await managedCheck(env, directory)) { report.reason = 'managed_configuration_unverified'; return report; }
    phase = 'doctor_setup';
    const ledger = join(directory, 'ledger.sqlite'), intent = join(directory, 'intent.sqlite');
    const checked = await doctor(['--claude-executable', executable, '--db', ledger, '--tenant', 'synthetic-failure-probe',
      '--scope', 'mixed-outcomes', '--intent-mode', 'explicit-summary', '--intent-db', intent]);
    if (checked.exitCode !== 0 || !checked.report?.setup?.settings) { report.reason = 'doctor_prerequisites_failed'; return report; }
    const settings = checked.report.setup.settings, settingsPath = join(directory, 'settings.json');
    writeFileSync(settingsPath, JSON.stringify({ autoMemoryEnabled: false, claudeMdExcludes: ['**'], ...settings }), { mode: 0o600 });
    const okText = `SYNTHETIC_OK_${randomUUID()}`, failText = `SYNTHETIC_FAIL_${randomUUID()}`, token = `synthetic-${randomUUID()}`;
    const receiptPath = join(directory, 'tool-receipts.jsonl');
    const mcp = { mcpServers: { reflexmesh_fixture: { type: 'stdio', command: process.execPath,
      args: [join(ROOT, 'scripts', 'claude-failure-tools.mjs'), receiptPath, okText, failText] } } };
    phase = 'fixture_bind';
    service = await startFixture({ model: MODEL, token, okText, failText, marker: MARKER });
    env.ANTHROPIC_BASE_URL = service.baseUrl; env.ANTHROPIC_API_KEY = token;
    const args = ['--restricted', '--print', '--output-format', 'stream-json', '--verbose', '--include-hook-events',
      '--no-session-persistence', '--setting-sources', '', '--disable-slash-commands', '--no-chrome', '--settings', settingsPath,
      '--strict-mcp-config', '--mcp-config', JSON.stringify(mcp), '--tools', '', '--allowedTools', FAILURE_TOOL,
      '--permission-mode', 'dontAsk', '--permission-prompts', 'none', '--model', MODEL, '--max-turns', '3',
      '--system-prompt', 'Isolated compatibility fixture. Use only the supplied synthetic MCP tool.',
      `ReflexMesh-Intent: ${FAILURE_SUMMARY}\nRun the fixture batch once.`];
    phase = 'host_run';
    const host = await runHost(executable, args, { cwd: directory, env, timeoutMs, stdoutLimitBytes: 1024 * 1024, stderrLimitBytes: 65536 });
    phase = 'evidence_read';
    report.transport = service.snapshot();
    if (!host.ok) { report.reason = processFailureReason(host); return report; }
    let records = [], pairs = [], schemaVersion = null, pairCount = null, cacheCount = null;
    if (existsSync(ledger)) {
      const kernel = new SqliteKernel(ledger, { readOnly: true });
      try { records = kernel.listEvidence({ limit: 10 }).items.map(item => ({ key: item.key, ...kernel.inspect(item.key) }));
        pairs = records.map(item => kernel.pairingSnapshot(item.key)); }
      finally { kernel.close(); }
      const raw = new DatabaseSync(ledger, { readOnly: true });
      try { schemaVersion = raw.prepare('PRAGMA user_version').get().user_version;
        pairCount = raw.prepare('SELECT count(*) n FROM claude_hook_pairs').get().n; }
      finally { raw.close(); }
    }
    if (existsSync(intent)) {
      const cache = new DatabaseSync(intent, { readOnly: true });
      try { cacheCount = cache.prepare('SELECT count(*) n FROM intents').get().n; } finally { cache.close(); }
    }
    const receipts = existsSync(receiptPath) ? readFileSync(receiptPath, 'utf8').trim().split(/\r?\n/).map(JSON.parse) : [];
    phase = 'evidence_verify';
    report.assertions = evaluateClaudeFailureRun({ stdout: host.stdout, settings, childEnv: env, records, pairs, receipts,
      transport: report.transport, ledger, intent, schemaVersion, pairCount, cacheCount,
      minimized: ![okText, failText, token, FAILURE_SUMMARY].some(value => JSON.stringify(records).includes(value)) });
    report.status = report.assertions.every(item => item.passed) ? 'passed' : 'failed';
    report.reason = report.status === 'passed' ? 'mixed_outcomes_passed' : 'probe_assertion_failed';
  } catch (error) {
    report.reason = 'probe_execution_failed';
    report.diagnostic = { phase, code: diagnosticCode(error) };
  }
  finally {
    try {
      await service?.close();
      if (directory) {
        const target = realpathSync(directory);
        if (dirname(target) !== temporaryRoot || !basename(target).startsWith(PREFIX)) throw new Error('unsafe_cleanup');
        remove(target, { recursive: true, force: true });
      }
    } catch { report.status = 'failed'; report.reason = 'probe_cleanup_failed'; }
  }
  return report;
}

export async function main(argv = process.argv.slice(2), output = process.stdout) {
  if (argv.length === 1 && ['--help', '-h'].includes(argv[0])) {
    output.write('Usage: npm run compat:claude-failure -- [--claude-command NATIVE_EXECUTABLE]\n'
      + 'Installed Windows Claude Code 2.1.263; direct production hooks and two concurrent synthetic MCP outcomes.\n'
      + 'Starts the installed host, uses strict localhost Messages; no real model/account/default profile.\n'
      + 'Does not prove actual cancellation or is_interrupt delivery. Not an OS sandbox.\n'); return 0;
  }
  const valid = argv.length === 0 || argv.length === 2 && argv[0] === '--claude-command';
  const report = valid ? await runClaudeFailureProbe(argv.length ? { claudeCommand: argv[1] } : {})
    : { schemaVersion: 1, status: 'failed', reason: 'invalid_options', modelInference: false };
  output.write(JSON.stringify(report) + '\n'); return report.status === 'passed' ? 0 : 1;
}
if (isDirectRun(import.meta.url)) process.exitCode = await main();

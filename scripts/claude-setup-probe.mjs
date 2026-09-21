#!/usr/bin/env node
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { SqliteKernel, digest } from '../adapters/sqlite-kernel.mjs';
import { eventKey } from '../adapters/durable-mesh.mjs';
import { diagnoseClaudeDoctor } from '../adapters/claude-doctor.mjs';
import { isDirectRun } from '../adapters/direct-run.mjs';
import { localEnvironment, ancestorContextAbsent, managedConfigurationAbsent } from './claude-local-probe.mjs';
import { resolveExecutable, runBounded, processFailureReason, evaluateClaudeJsonl } from './real-host-compat.mjs';
import { startClaudeFixture } from './claude-loopback-server.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PREFIX = 'reflexmesh-claude-setup-', VERSION = '2.1.263';
const SUMMARY = 'Read only the isolated setup fixture; do not modify files.';
const MARKER = 'REFLEXMESH_CLAUDE_SETUP_OK', TENANT = 'synthetic-setup-probe';
const EVENTS = ['UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'Stop'];
const ALL_EVENTS = ['UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'Stop', 'StopFailure', 'SessionEnd'];
const row = (name, passed) => ({ name, passed: passed === true });
const sqliteWarningOnly = text => typeof text === 'string' && /^(?:\(node:\d+\) ExperimentalWarning: SQLite is an experimental feature and might change at any time\r?\n\(Use `node --trace-warnings \.\.\.` to show where the warning was created\)\r?\n)?$/.test(text);

export function evaluateClaudeSetupRun({ stdout, settings, childEnv, scenario, fixture, records, pairs,
  schemaVersion, pairCount, cacheExists, cacheCount, fixtureUnchanged, minimizedLedger, server }) {
  let stream;
  try {
    stream = stdout.split(/\r?\n/).filter(Boolean).map(JSON.parse);
    if (stream.some(value => !value || typeof value !== 'object' || Array.isArray(value))) throw new Error('invalid');
  } catch { return [row('well_formed_host_stream', false)]; }
  const optIn = scenario === 'explicit-summary', scope = `setup-${scenario}`;
  const finals = stream.filter(item => item.type === 'result');
  const sessionId = finals[0]?.session_id;
  const calls = stream.filter(item => item.type === 'assistant' && Array.isArray(item.message?.content))
    .flatMap(item => item.message.content.filter(block => block?.type === 'tool_use').map(block => ({ item, block })));
  const users = stream.filter(item => item.type === 'user' && item.tool_use_result !== undefined);
  const hooks = stream.filter(item => item.type === 'system' && item.subtype?.startsWith('hook_'));
  const record = records[0], pair = pairs[0], task = record?.evidence?.taskEvidence;
  const key = typeof sessionId === 'string' ? eventKey({ tenantId: TENANT, source: `reflexmesh:${scope}:claude-code`,
    id: digest([sessionId, 'root', 'reflexmesh_fixture_read', 'before']) }) : null;
  const ownSettings = settings && Object.keys(settings).sort().join(',') === 'env,hooks'
    && Object.keys(settings.hooks ?? {}).sort().join(',') === [...ALL_EVENTS].sort().join(',')
    && ALL_EVENTS.every(event => {
      const entries = settings.hooks[event], hook = entries?.[0]?.hooks?.[0];
      return entries?.length === 1 && entries[0].hooks?.length === 1 && hook?.type === 'command'
        && hook.command === process.execPath && hook.args?.length === 1
        && hook.args[0] === join(ROOT, 'adapters', 'claude-task-hook.mjs') && hook.timeout === 10
        && Object.keys(hook).sort().join(',') === 'args,command,timeout,type'
        && (event.includes('ToolUse') ? entries[0].matcher === '*' : entries[0].matcher === undefined);
    });
  const orderedHooks = hooks.length === 8 && EVENTS.every((event, index) => {
    const start = hooks[index * 2], end = hooks[index * 2 + 1];
    return start?.subtype === 'hook_started' && end?.subtype === 'hook_response'
      && start.hook_event === event && end.hook_event === event
      && typeof start.hook_id === 'string' && start.hook_id.length > 0 && start.hook_id === end.hook_id
      && start.session_id === sessionId && end.session_id === sessionId
      && end.exit_code === 0 && end.outcome === 'success'
      && end.stdout?.trim() === '{}' && sqliteWarningOnly(end.stderr);
  });
  const resultBlocks = users[0]?.message?.content;
  return [
    row('doctor_settings_use_only_direct_production_hooks', Boolean(ownSettings)),
    row('no_inherited_reflexmesh_deployment_configuration', Object.keys(childEnv).every(name => !/^REFLEXMESH_/i.test(name))),
    row('settings_supply_exact_shadow_deployment', settings?.env?.REFLEXMESH_TENANT === TENANT
      && settings.env.REFLEXMESH_SCOPE === scope && settings.env.REFLEXMESH_PROVIDER === 'abstain'
      && settings.env.REFLEXMESH_ALLOW_REMOTE === 'false' && settings.env.REFLEXMESH_TASK_EVIDENCE === 'true'
      && settings.env.REFLEXMESH_INTENT_MODE === (optIn ? 'explicit-summary' : 'off')),
    row('structured_single_fixture_read', evaluateClaudeJsonl(stdout, fixture, MARKER).passed
      && calls.length === 1 && calls[0].block.id === 'reflexmesh_fixture_read'
      && calls[0].item.session_id === sessionId),
    row('successful_final_result_in_one_session', finals.length === 1 && finals[0].is_error === false
      && finals[0].subtype === 'success' && typeof sessionId === 'string' && sessionId.length > 0
      && hooks.length === 8 && stream.indexOf(finals[0]) > stream.indexOf(hooks.at(-1))),
    row('successful_ordered_direct_hook_responses', orderedHooks),
    row('local_read_proof_and_exact_transport', server.helloRequests === 1 && server.messageRequests === 2
      && server.tokenRequests === 0 && server.readRequested && server.resultMatched && server.completed
      && !server.unexpectedRequest && server.boundedFailure === 'none'),
    row('one_exact_ledger_key', records.length === 1 && record?.key === key),
    row('schema_three_one_ready_pair', schemaVersion === 3 && pairCount === 1 && pairs.length === 1
      && pair?.state === 'ready' && pair?.reasonCode === null),
    row('completed_shadow_abstain_binding', record?.state === 'completed' && record?.evidence?.mode === 'shadow'
      && record?.evidence?.binding?.providerId === 'abstain' && record?.evidence?.binding?.modelId === 'not-configured'),
    row('exact_task_capture_policy', optIn ? task?.status === 'ready' && task.source === 'claude-explicit-summary'
      && task.coverage === 'summary-only' && task.summaryDigest === digest(SUMMARY)
      && typeof sessionId === 'string' && task.scopeDigest === digest({ harness: 'claude-code', sessionId, agentId: 'root' })
      : task?.status === 'missing' && task.coverage === 'none'),
    row('exact_action_digest', calls.length === 1 && record?.evidence?.actionDigest === digest({ toolId: 'Read', args: calls[0].block.input })),
    row('single_matching_native_result', users.length === 1 && users[0].session_id === sessionId
      && Array.isArray(resultBlocks) && resultBlocks.filter(block => block?.type === 'tool_result').length === 1
      && resultBlocks.find(block => block?.type === 'tool_result')?.tool_use_id === 'reflexmesh_fixture_read'
      && [undefined, false].includes(resultBlocks.find(block => block?.type === 'tool_result')?.is_error)),
    row('exact_harness_outcome_digest', users.length === 1 && record?.observations?.length === 1
      && record.observations[0].status === 'succeeded' && record.observations[0].provenance === 'harness-reported'
      && record.observations[0].evidenceDigest === digest(users[0].tool_use_result)),
    row('zero_independent_labels', record?.labels?.length === 0),
    // A direct installation has no wrapper measuring Stop: do not attribute this to Stop alone.
    row('capture_cache_matches_mode_at_exit', optIn ? cacheExists === true && cacheCount === 0 : cacheExists === false),
    row('fixture_unchanged_and_ledger_minimized', fixtureUnchanged === true && minimizedLedger === true),
  ];
}

export async function runClaudeSetupScenario(executable, scenario, timeoutMs, {
  runHost = runBounded, doctor = diagnoseClaudeDoctor, platform = process.platform,
  systemTemp = process.env.SystemRoot && join(process.env.SystemRoot, 'Temp'),
  ancestorCheck = ancestorContextAbsent, managedCheck = managedConfigurationAbsent, remove = rmSync,
} = {}) {
  let directory, temporaryRoot, service;
  const report = { scenario, status: 'failed', reason: 'probe_execution_failed', assertions: [] };
  try {
    if (platform !== 'win32' || !systemTemp) { report.reason = 'unsupported_host_platform'; return report; }
    temporaryRoot = realpathSync(systemTemp);
    if (!ancestorCheck(temporaryRoot)) { report.reason = 'ambient_context_unverified'; return report; }
    directory = mkdtempSync(join(temporaryRoot, PREFIX));
    const env = localEnvironment(process.env, { directory, baseUrl: 'http://127.0.0.1:1', token: 'synthetic', scenario });
    for (const name of Object.keys(env)) if (/^REFLEXMESH_/i.test(name)) delete env[name];
    for (const name of ['CLAUDE_CONFIG_DIR', 'ANTHROPIC_CONFIG_DIR', 'CLAUDE_CODE_PLUGIN_CACHE_DIR']) mkdirSync(env[name], { mode: 0o700 });
    if (!await managedCheck(env, directory)) { report.reason = 'managed_configuration_unverified'; return report; }
    const dbPath = join(directory, 'ledger.sqlite'), intentPath = join(directory, 'intent.sqlite');
    const doctorArgs = ['--claude-executable', executable, '--db', dbPath, '--tenant', TENANT, '--scope', `setup-${scenario}`,
      '--intent-db', intentPath, ...(scenario === 'explicit-summary' ? ['--intent-mode', 'explicit-summary'] : [])];
    const checked = await doctor(doctorArgs);
    if (checked.exitCode !== 0 || !checked.report?.setup?.settings) { report.reason = 'doctor_prerequisites_failed'; return report; }
    const settings = checked.report.setup.settings;
    const fixture = join(directory, 'fixture.txt'), fixtureText = `LOCAL_SETUP_PROOF_${randomUUID()}`;
    const token = `synthetic-${randomUUID()}`;
    writeFileSync(fixture, fixtureText + '\n', { mode: 0o600 });
    // Preserve the generated env/hooks unchanged; only add test-session isolation settings.
    const settingsPath = join(directory, 'settings.json');
    writeFileSync(settingsPath, JSON.stringify({ autoMemoryEnabled: false, claudeMdExcludes: ['**'], ...settings }), { mode: 0o600 });
    service = await startClaudeFixture({ model: 'claude-sonnet-4-6', fixturePath: fixture, fixtureText, token, marker: MARKER });
    env.ANTHROPIC_BASE_URL = service.baseUrl; env.ANTHROPIC_API_KEY = token;
    const args = ['--restricted', '--print', '--output-format', 'stream-json', '--verbose', '--include-hook-events',
      '--no-session-persistence', '--setting-sources', '', '--disable-slash-commands', '--no-chrome', '--settings', settingsPath,
      '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}', '--tools', 'Read', '--allowedTools', 'Read',
      '--permission-mode', 'dontAsk', '--permission-prompts', 'none', '--model', 'claude-sonnet-4-6', '--max-turns', '3',
      '--system-prompt', 'This is an isolated setup compatibility check. Read only the supplied synthetic fixture.',
      `ReflexMesh-Intent: ${SUMMARY}\nRead the isolated fixture at ${JSON.stringify(fixture)} once.`];
    const host = await runHost(executable, args, { cwd: directory, env, timeoutMs, stdoutLimitBytes: 1024 * 1024, stderrLimitBytes: 65536 });
    report.transport = service.snapshot();
    if (!host.ok) { report.reason = processFailureReason(host); return report; }
    let records = [], pairs = [], schemaVersion = null, pairCount = null, cacheCount = null;
    if (existsSync(dbPath)) {
      const kernel = new SqliteKernel(dbPath, { readOnly: true });
      try { records = kernel.listEvidence({ limit: 10 }).items.map(item => ({ key: item.key, ...kernel.inspect(item.key) }));
        pairs = records.map(item => kernel.pairingSnapshot(item.key)); }
      finally { kernel.close(); }
      const raw = new DatabaseSync(dbPath, { readOnly: true });
      try { schemaVersion = raw.prepare('PRAGMA user_version').get().user_version;
        pairCount = raw.prepare('SELECT count(*) n FROM claude_hook_pairs').get().n; }
      finally { raw.close(); }
    }
    const cacheExists = existsSync(intentPath);
    if (cacheExists) {
      const cache = new DatabaseSync(intentPath, { readOnly: true });
      try { cacheCount = cache.prepare('SELECT count(*) n FROM intents').get().n; }
      finally { cache.close(); }
    }
    report.assertions = evaluateClaudeSetupRun({ stdout: host.stdout, settings, childEnv: env, scenario, fixture,
      records, pairs, schemaVersion, pairCount, cacheExists, cacheCount, server: report.transport,
      fixtureUnchanged: readFileSync(fixture, 'utf8') === fixtureText + '\n',
      minimizedLedger: ![SUMMARY, fixtureText, token].some(text => JSON.stringify(records).includes(text)) });
    report.status = report.assertions.every(item => item.passed) ? 'passed' : 'failed';
    report.reason = report.status === 'passed' ? 'generated_setup_loop_passed' : 'probe_assertion_failed';
  } catch { report.reason = 'probe_execution_failed'; }
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

export async function runClaudeSetupProbe({ claudeCommand = 'claude', timeoutMs = 60000 } = {}) {
  const report = { schemaVersion: 1, evidenceLevel: 'installed_claude_generated_setup', hostVersion: 'unverified',
    modelInference: false, modelTransport: 'loopback_fixture', defaultProfileUsed: false,
    status: 'failed', reason: 'invalid_options', scenarios: [] };
  if (typeof claudeCommand !== 'string' || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 120000) return report;
  const executable = resolveExecutable(claudeCommand, { host: 'claude' });
  if (!executable) return { ...report, reason: 'host_command_not_found' };
  const version = await runBounded(executable, ['--version'], { cwd: ROOT, env: {}, timeoutMs: 10000,
    stdoutLimitBytes: 1024, stderrLimitBytes: 1024 });
  if (!version.ok || version.stdout.trim() !== `${VERSION} (Claude Code)`) return { ...report, reason: 'unsupported_host_version' };
  report.hostVersion = VERSION;
  for (const scenario of ['capture-off', 'explicit-summary']) {
    const result = await runClaudeSetupScenario(executable, scenario, timeoutMs);
    report.scenarios.push(result);
    if (result.status !== 'passed') { report.reason = result.reason; return report; }
  }
  return { ...report, status: 'passed', reason: 'generated_setup_loops_passed' };
}

export async function main(argv = process.argv.slice(2), output = process.stdout) {
  if (argv.length === 1 && ['--help', '-h'].includes(argv[0])) {
    output.write('Usage: npm run compat:claude-setup -- [--claude-command NATIVE_EXECUTABLE]\n'
      + 'Installed Windows Claude Code 2.1.263; direct doctor-generated hooks, synthetic localhost Messages.\n'
      + 'No real model/account/default profile. Runs default capture-off and explicit-summary in fresh sessions.\n'
      + 'This opt-in probe starts Claude; doctor:claude itself never starts a host. Not an OS sandbox.\n');
    return 0;
  }
  const valid = argv.length === 0 || argv.length === 2 && argv[0] === '--claude-command';
  const report = valid ? await runClaudeSetupProbe(argv.length ? { claudeCommand: argv[1] } : {})
    : { schemaVersion: 1, status: 'failed', reason: 'invalid_options', modelInference: false };
  output.write(JSON.stringify(report) + '\n');
  return report.status === 'passed' ? 0 : 1;
}
if (isDirectRun(import.meta.url)) process.exitCode = await main();

#!/usr/bin/env node
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { DatabaseSync } from 'node:sqlite';
import { SqliteKernel, digest } from '../adapters/sqlite-kernel.mjs';
import { eventKey } from '../adapters/durable-mesh.mjs';
import { diagnoseClaudeDoctor } from '../adapters/claude-doctor.mjs';
import { isDirectRun } from '../adapters/direct-run.mjs';
import { localEnvironment, ancestorContextAbsent, managedConfigurationAbsent } from './claude-local-probe.mjs';
import { resolveExecutable, runBounded } from './real-host-compat.mjs';
import { RESUME_TOOL, resumeCall, startClaudeResumeFixture } from './claude-resume-server.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..'), PREFIX = 'reflexmesh-claude-resume-';
const SUMMARY_A = 'Read the first isolated synthetic memory fixture only.';
const SUMMARY_B = 'Read the second isolated synthetic memory fixture only.';
const row = (name, passed) => ({ name, passed: passed === true });
const limits = { timeoutMs: 60000, stdoutLimitBytes: 1024 * 1024, stderrLimitBytes: 65536 };
const parseLines = text => text.split(/\r?\n/).filter(Boolean).map(JSON.parse);
const sqliteWarningOnly = text => typeof text === 'string' && /^(?:\(node:\d+\) ExperimentalWarning: SQLite is an experimental feature and might change at any time\r?\n\(Use `node --trace-warnings \.\.\.` to show where the warning was created\)\r?\n)?$/.test(text);

export function validResumeHooks(stream, expectedEvents, sessionId, finalRequired) {
  const hooks = stream.filter(item => item.type === 'system' && item.subtype?.startsWith('hook_'));
  const finals = stream.filter(item => item.type === 'result');
  return hooks.length === expectedEvents.length * 2 && expectedEvents.every((event, index) => {
    const start = hooks[index * 2], end = hooks[index * 2 + 1];
    return start?.subtype === 'hook_started' && end?.subtype === 'hook_response'
      && start.hook_event === event && end.hook_event === event && typeof start.hook_id === 'string' && start.hook_id.length > 0 && start.hook_id === end.hook_id
      && start.session_id === sessionId && end.session_id === sessionId && end.exit_code === 0 && end.outcome === 'success'
      && end.stdout?.trim() === '{}' && sqliteWarningOnly(end.stderr);
  }) && (finalRequired ? finals.length === 1 && stream.indexOf(finals[0]) > stream.indexOf(hooks.at(-1)) : finals.length === 0);
}

/** Owned child only. A close receipt, not a deadline fallback, is required before resuming. */
export function runResumeHost(executable, args, { cwd, env, signal, timeoutMs = 60000 }) {
  return new Promise(resolveResult => {
    const child = spawn(executable, args, { cwd, env, shell: false, detached: process.platform !== 'win32', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let reason = null, done = false, stderrBytes = 0, stdoutBytes = 0, cleanupTimer;
    const chunks = [];
    const finish = (code, closed) => {
      if (done) return; done = true; clearTimeout(timer); clearTimeout(cleanupTimer); signal?.removeEventListener('abort', onAbort);
      resolveResult({ ok: code === 0 && !reason, closed, pid: child.pid, kind: reason ?? (code === 0 ? 'success' : 'nonzero_exit'), stdout: Buffer.concat(chunks).toString('utf8') });
    };
    const stop = why => {
      if (reason || done) return; reason = why;
      if (process.platform === 'win32' && child.pid) {
        const killer = spawn(join(env.SystemRoot, 'System32', 'taskkill.exe'), ['/PID', String(child.pid), '/T', '/F'], { shell: false, windowsHide: true, stdio: 'ignore' });
        killer.once('error', () => { try { child.kill('SIGKILL'); } catch {} }); killer.unref();
      } else if (child.pid) { try { process.kill(-child.pid, 'SIGKILL'); } catch { try { child.kill('SIGKILL'); } catch {} } }
      cleanupTimer = setTimeout(() => { try { child.kill('SIGKILL'); } catch {} child.stdout.destroy(); child.stderr.destroy(); child.unref(); finish(null, false); }, 3000);
    };
    const onAbort = () => stop('barrier_terminated');
    const timer = setTimeout(() => stop('timeout'), timeoutMs);
    signal?.addEventListener('abort', onAbort, { once: true }); if (signal?.aborted) onAbort();
    child.stdout.on('data', chunk => { stdoutBytes += chunk.length; if (stdoutBytes > limits.stdoutLimitBytes) stop('stdout_limit'); else chunks.push(chunk); });
    child.stderr.on('data', chunk => { stderrBytes += chunk.length; if (stderrBytes > limits.stderrLimitBytes) stop('stderr_limit'); });
    child.once('error', () => { reason ??= 'spawn_error'; finish(null, false); });
    child.once('close', code => finish(code, true));
  });
}

/** Search only the fresh private config/projects, at the known transcript depth, never global session IDs. */
export function findResumeTranscript(config, sessionId) {
  if (!/^[a-z0-9-]{36}$/.test(sessionId)) throw new Error('invalid_session');
  const root = realpathSync(config), projects = join(root, 'projects');
  if (!existsSync(projects)) return null;
  if (lstatSync(projects).isSymbolicLink() || realpathSync(projects) !== projects) throw new Error('unsafe_transcript');
  const dirs = readdirSync(projects, { withFileTypes: true });
  if (dirs.length > 16) throw new Error('unexpected_projects');
  const found = [];
  for (const dir of dirs) {
    if (!dir.isDirectory() || dir.isSymbolicLink()) throw new Error('unexpected_project');
    const path = join(projects, dir.name, `${sessionId}.jsonl`);
    if (!existsSync(path)) continue;
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1024 * 1024 || realpathSync(dirname(path)) !== dirname(path) || realpathSync(path) !== path) throw new Error('unsafe_transcript');
    found.push(path);
  }
  if (found.length > 1) throw new Error('ambiguous_transcript');
  return found[0] ?? null;
}
function readLedger(path) {
  const kernel = new SqliteKernel(path, { readOnly: true });
  try { return kernel.listEvidence({ limit: 10 }).items.map(item => ({ key: item.key, ...kernel.inspect(item.key), pair: kernel.pairingSnapshot(item.key) })); }
  finally { kernel.close(); }
}
function cacheCount(path) {
  if (!existsSync(path)) return null;
  const db = new DatabaseSync(path, { readOnly: true });
  try { return db.prepare('SELECT count(*) n FROM intents').get().n; } finally { db.close(); }
}
function native(stream, phase) {
  const uses = stream.filter(item => item.type === 'assistant').flatMap(item => item.message?.content ?? []).filter(block => block.type === 'tool_use');
  const results = stream.filter(item => item.type === 'user').flatMap(item => item.message?.content ?? []).filter(block => block.type === 'tool_result');
  return { uses: uses.filter(block => block.id === `resume_call_${phase}`), results: results.filter(block => block.tool_use_id === `resume_call_${phase}`) };
}

export async function runClaudeResumeScenario(executable, interrupted, timeoutMs = 60000, { doctor = diagnoseClaudeDoctor } = {}) {
  const report = { scenario: interrupted ? 'entered-then-killed' : 'clean-exit', status: 'failed', reason: 'probe_execution_failed', assertions: [] };
  let directory, service, temporaryRoot, barrier = false;
  try {
    if (process.platform !== 'win32' || !process.env.SystemRoot) { report.reason = 'unsupported_host_platform'; return report; }
    temporaryRoot = realpathSync(join(process.env.SystemRoot, 'Temp'));
    if (!ancestorContextAbsent(temporaryRoot)) { report.reason = 'ambient_context_unverified'; return report; }
    directory = mkdtempSync(join(temporaryRoot, PREFIX));
    const env = localEnvironment(process.env, { directory, baseUrl: 'http://127.0.0.1:1', token: 'synthetic', scenario: 'resume' });
    for (const key of Object.keys(env)) if (/^REFLEXMESH_/i.test(key)) delete env[key];
    for (const key of ['CLAUDE_CONFIG_DIR', 'ANTHROPIC_CONFIG_DIR', 'CLAUDE_CODE_PLUGIN_CACHE_DIR']) mkdirSync(env[key], { mode: 0o700 });
    if (!await managedConfigurationAbsent(env, directory)) { report.reason = 'managed_configuration_unverified'; return report; }
    const ledger = join(directory, 'ledger.sqlite'), intent = join(directory, 'intent.sqlite');
    const checked = await doctor(['--claude-executable', executable, '--db', ledger, '--intent-db', intent,
      '--tenant', 'synthetic-resume-probe', '--scope', 'cold-resume', '--intent-mode', 'explicit-summary']);
    if (checked.exitCode !== 0 || !checked.report?.setup?.settings) { report.reason = 'doctor_prerequisites_failed'; return report; }
    const settings = checked.report.setup.settings, settingsPath = join(directory, 'settings.json');
    writeFileSync(settingsPath, JSON.stringify({ autoMemoryEnabled: false, claudeMdExcludes: ['**'], ...settings }), { mode: 0o600 });
    const sessionId = randomUUID(), proof = `SYNTHETIC_RESUME_${randomUUID()}`, token = `synthetic-${randomUUID()}`;
    const firstPrompt = `ReflexMesh-Intent: ${SUMMARY_A}\nRead the phase 1 fixture once.`;
    const secondPrompt = `${interrupted ? '' : `ReflexMesh-Intent: ${SUMMARY_B}\n`}Read only the new phase 2 fixture once; do not re-execute old calls.`;
    const controller = new AbortController();
    service = await startClaudeResumeFixture({ token, proof, firstPrompt, secondPrompt, interrupted, onEntered: async () => {
      // Wait for observed persistence, not an arbitrary delay, while the fixed tool cannot finish.
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline) {
        const transcript = findResumeTranscript(env.CLAUDE_CONFIG_DIR, sessionId);
        if (transcript && readFileSync(transcript, 'utf8').includes('resume_call_1') && existsSync(ledger)) {
          const records = readLedger(ledger);
          if (records.length === 1 && records[0].state === 'completed' && records[0].pair?.state === 'ready' && records[0].observations.length === 0) {
            barrier = true; controller.abort(); return;
          }
        }
        await delay(25);
      }
      throw new Error('barrier_not_observed');
    } });
    env.ANTHROPIC_BASE_URL = service.baseUrl; env.ANTHROPIC_API_KEY = token;
    const args = phase => ['--restricted', '--print', '--output-format', 'stream-json', '--verbose', '--include-hook-events',
      '--setting-sources', '', '--disable-slash-commands', '--no-chrome', '--settings', settingsPath,
      '--strict-mcp-config', '--mcp-config', JSON.stringify({ mcpServers: { reflexmesh_fixture: { type: 'stdio', command: process.execPath,
        args: [join(ROOT, 'scripts', 'claude-resume-tools.mjs'), service.baseUrl, token, String(phase)] } } }),
      '--tools', '', '--allowedTools', RESUME_TOOL, '--permission-mode', 'dontAsk', '--permission-prompts', 'none',
      '--model', 'claude-sonnet-4-6', '--max-turns', '3', '--system-prompt', 'Isolated cold-resume fixture. Use only the supplied memory-only MCP tool.'];
    const first = await runResumeHost(executable, [...args(1), '--session-id', sessionId, firstPrompt], { cwd: directory, env, signal: controller.signal, timeoutMs });
    if (!first.closed || (interrupted ? !barrier || first.kind !== 'barrier_terminated' : !first.ok)) {
      report.reason = 'first_process_not_verified'; report.transport = service.snapshot(); return report;
    }
    const transcript = findResumeTranscript(env.CLAUDE_CONFIG_DIR, sessionId);
    if (!transcript) { report.reason = 'persisted_session_missing'; return report; }
    if (!existsSync(ledger)) { report.reason = 'persisted_ledger_missing'; report.transport = service.snapshot(); return report; }
    const before = readLedger(ledger), beforeCache = cacheCount(intent);
    service.resume();
    const second = await runResumeHost(executable, [...args(2), '--resume', transcript, secondPrompt], { cwd: directory, env, timeoutMs });
    report.transport = service.snapshot();
    if (!second.ok || !second.closed) { report.reason = 'resume_process_failed'; return report; }
    const after = readLedger(ledger), one = parseLines(first.stdout), two = parseLines(second.stdout);
    const byPhase = phase => after.find(item => item.key === eventKey({ tenantId: 'synthetic-resume-probe', source: 'reflexmesh:cold-resume:claude-code', id: digest([sessionId, 'root', `resume_call_${phase}`, 'before']) }));
    const old = byPhase(1), fresh = byPhase(2), firstNative = native(one, 1), secondNative = native(two, 2);
    const task = fresh?.evidence?.taskEvidence;
    const attentionProcess = await runBounded(process.execPath, [join(ROOT, 'adapters', 'evidence-cli.mjs'), 'attention', '--db', ledger, '--json'], { ...limits, cwd: directory, env: {} });
    const attention = attentionProcess.ok ? JSON.parse(attentionProcess.stdout) : null;
    const final = two.filter(item => item.type === 'result');
    const firstFinal = one.filter(item => item.type === 'result');
    const allEvents = ['UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'Stop', 'StopFailure', 'SessionEnd'];
    report.assertions = [
      row('generated_direct_production_hooks_unchanged', Object.keys(settings).sort().join(',') === 'env,hooks'
        && Object.keys(settings.hooks).sort().join(',') === [...allEvents].sort().join(',')
        && allEvents.every(event => { const group = settings.hooks[event], hook = group?.[0]?.hooks?.[0];
          return group?.length === 1 && group[0].hooks?.length === 1 && hook?.type === 'command' && hook.command === process.execPath
            && hook.args?.length === 1 && hook.args[0] === join(ROOT, 'adapters', 'claude-task-hook.mjs') && hook.timeout === 10
            && Object.keys(hook).sort().join(',') === 'args,command,timeout,type'; })),
      row('explicit_isolated_shadow_deployment', Object.keys(env).every(key => !/^REFLEXMESH_/i.test(key))
        && settings.env.REFLEXMESH_PROVIDER === 'abstain' && settings.env.REFLEXMESH_ALLOW_REMOTE === 'false'
        && settings.env.REFLEXMESH_DB === ledger && settings.env.REFLEXMESH_INTENT_DB === intent
        && settings.env.REFLEXMESH_INTENT_MODE === 'explicit-summary' && settings.env.REFLEXMESH_TASK_EVIDENCE === 'true'),
      row('two_distinct_closed_native_processes', first.closed && second.closed && Number.isInteger(first.pid) && first.pid !== second.pid),
      row('same_persisted_session_and_successful_resume', final.length === 1 && final[0].session_id === sessionId && final[0].is_error === false && final[0].subtype === 'success'),
      row('resumed_synthetic_history_proven_by_transport', report.transport.resumedHistory && report.transport.stage === 'done' && report.transport.failure === 'none'
        && report.transport.helloRequests === 2 && report.transport.messageRequests === (interrupted ? 3 : 4)),
      row('exactly_two_memory_only_tool_entries_without_old_retry', report.transport.entries.length === 2 && report.transport.entries[0].phase === 1 && report.transport.entries[1].phase === 2
        && report.transport.entries[0].pid !== report.transport.entries[1].pid && report.transport.entries[0].returned === !interrupted && report.transport.entries[1].returned),
      row('first_phase_persisted_before_resume', before.length === 1 && before[0].state === 'completed' && before[0].pair?.state === 'ready'
        && before[0].observations.length === (interrupted ? 0 : 1) && firstNative.uses.length === 1 && firstNative.results.length === (interrupted ? 0 : 1)),
      row('first_result_absent_or_exactly_reported', interrupted ? firstFinal.length === 0 && old?.observations.length === 0
        : firstFinal.length === 1 && firstFinal[0].session_id === sessionId && firstFinal[0].is_error === false && firstFinal[0].subtype === 'success'
          && old?.observations.length === 1 && old.observations[0].status === 'succeeded' && old.observations[0].provenance === 'harness-reported'
          && old.observations[0].evidenceDigest === digest(firstNative.results[0].content)),
      row('barrier_and_cache_state_before_resume', interrupted ? barrier && beforeCache === 1 : !barrier && beforeCache === 0),
      row('old_decision_pair_and_outcomes_unchanged', Boolean(old) && JSON.stringify(old) === JSON.stringify(before[0])),
      row('two_exact_completed_shadow_abstain_decisions', after.length === 2 && [old, fresh].every(item => item?.state === 'completed' && item.evidence?.mode === 'shadow'
        && item.evidence?.binding?.providerId === 'abstain' && item.pair?.state === 'ready' && item.pair?.reasonCode === null)),
      row('old_task_digest_retained', old?.evidence?.taskEvidence?.summaryDigest === digest(SUMMARY_A)),
      row('new_prompt_replaces_or_clears_old_task', interrupted ? task?.status === 'missing' && task.coverage === 'none'
        : task?.status === 'ready' && task.summaryDigest === digest(SUMMARY_B) && task.source === 'claude-explicit-summary'),
      row('per_call_action_digests', [1, 2].every(phase => byPhase(phase)?.evidence?.actionDigest === digest({ toolId: RESUME_TOOL, args: resumeCall(phase).input }))),
      row('new_native_call_and_reported_result', secondNative.uses.length === 1 && JSON.stringify(secondNative.uses[0]) === JSON.stringify(resumeCall(2)) && secondNative.results.length === 1
        && fresh?.observations.length === 1 && fresh.observations[0].status === 'succeeded' && fresh.observations[0].provenance === 'harness-reported'
        && fresh.observations[0].evidenceDigest === digest(secondNative.results[0].content)),
      row('first_process_exact_successful_hook_lifecycle', validResumeHooks(one, interrupted ? ['UserPromptSubmit', 'PreToolUse'] : ['UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'Stop'], sessionId, !interrupted)),
      row('new_prompt_pre_post_stop_production_hooks', validResumeHooks(two, ['UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'Stop'], sessionId, true)),
      row('public_attention_preserves_missing_observation', Boolean(attention) && (interrupted ? attention.items.length === 1 && attention.items[0].key === old?.key
        && attention.items[0].run.state === 'completed' && attention.items[0].hostOutcome.status === 'missing' && attention.items[0].recovery.required === false
        && attention.items[0].attention.reasons.some(item => item.code === 'shadow_outcome_missing') : attention.items.length === 0)),
      row('zero_labels_and_empty_cache_at_exit', after.every(item => item.labels.length === 0) && cacheCount(intent) === 0),
      row('raw_prompts_results_and_token_absent_from_ledger', ![SUMMARY_A, SUMMARY_B, proof, token, firstPrompt, secondPrompt].some(value => JSON.stringify(after).includes(value))),
    ];
    report.status = report.assertions.every(item => item.passed) ? 'passed' : 'failed';
    report.reason = report.status === 'passed' ? 'cold_resume_verified' : 'probe_assertion_failed';
  } catch { report.reason = 'probe_execution_failed'; }
  finally {
    try {
      await service?.close();
      if (directory) { const target = realpathSync(directory);
        if (dirname(target) !== temporaryRoot || !basename(target).startsWith(PREFIX)) throw new Error('unsafe_cleanup');
        rmSync(target, { recursive: true, force: true }); }
    } catch { report.status = 'failed'; report.reason = 'probe_cleanup_failed'; }
  }
  return report;
}

export async function main(argv = process.argv.slice(2), output = process.stdout) {
  if (argv.length === 1 && ['--help', '-h'].includes(argv[0])) {
    output.write('Usage: npm run compat:claude-resume -- [--claude-command NATIVE_EXECUTABLE]\nInstalled Windows Claude Code 2.1.263, two isolated cold-resume scenarios.\nSynthetic localhost Messages, memory-only MCP, explicit private transcript, no account/default profile.\nTerminates only the owned test process tree at an observed tool-entry barrier. Not an OS sandbox.\n'); return 0;
  }
  const report = { schemaVersion: 1, evidenceLevel: 'installed_claude_cold_resume', hostVersion: 'unverified', modelInference: false,
    modelTransport: 'loopback_fixture', defaultProfileUsed: false, status: 'failed', reason: 'invalid_options', scenarios: [] };
  if (argv.length === 0 || argv.length === 2 && argv[0] === '--claude-command') {
    const executable = resolveExecutable(argv[1] ?? 'claude', { host: 'claude' });
    if (!executable) report.reason = 'host_command_not_found';
    else {
      const version = await runBounded(executable, ['--version'], { ...limits, timeoutMs: 10000, cwd: ROOT, env: {} });
      if (!version.ok || version.stdout.trim() !== '2.1.263 (Claude Code)') report.reason = 'unsupported_host_version';
      else {
        report.hostVersion = '2.1.263';
        for (const interrupted of [false, true]) { const scenario = await runClaudeResumeScenario(executable, interrupted); report.scenarios.push(scenario); if (scenario.status !== 'passed') break; }
        report.status = report.scenarios.length === 2 && report.scenarios.every(item => item.status === 'passed') ? 'passed' : 'failed';
        report.reason = report.status === 'passed' ? 'cold_resume_scenarios_verified' : report.scenarios.at(-1)?.reason ?? 'probe_execution_failed';
      }
    }
  }
  output.write(JSON.stringify(report) + '\n'); return report.status === 'passed' ? 0 : 1;
}
if (isDirectRun(import.meta.url)) process.exitCode = await main();

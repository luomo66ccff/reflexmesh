#!/usr/bin/env node
import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, isAbsolute, join, relative, sep } from 'node:path';
import { SqliteKernel, digest } from '../adapters/sqlite-kernel.mjs';
import { eventKey } from '../adapters/durable-mesh.mjs';
import { intentDigest } from '../adapters/task-evidence.mjs';
import { inspectAgentPackages } from '../adapters/deepseek-installation.mjs';
import { isDirectRun } from '../adapters/direct-run.mjs';
import { MISSING_RESULT_ASSERTIONS, MISSING_RESULT_EVIDENCE, MISSING_RESULT_FAILURES,
  validateMissingResultStage } from './deepseek-missing-result-contract.mjs';
import { MISSING_RESULT_CALL_ID, MISSING_RESULT_TASK, MISSING_RESULT_TOOL } from './fixtures/deepseek-missing-result-fixture.mjs';

const PROFILE = 'reflexmesh-probe';
const ARGS = Object.freeze({ key: 'synthetic-only' });
const failure = (reason, hostVersion = 'unknown') => ({ schemaVersion: 1,
  ...MISSING_RESULT_EVIDENCE, agentLoopExercised: false, nativeToolBodyEntered: false,
  exitKind: 'unverified', hostVersion, status: 'failed',
  reason: MISSING_RESULT_FAILURES.includes(reason) ? reason : 'evidence_assertion_failed',
  assertions: MISSING_RESULT_ASSERTIONS.map(name => ({ name, passed: false })),
  preStop: null, postStop: null, supervisor: null });

export function isolatedMissingResultPatch({ packageRoot, dbPath, telemetryPath, homePath, cwdPath, runId }) {
  const observer = new URL('../adapters/deepseek-loader-plugin.mjs', import.meta.url).href;
  const fixture = new URL('./fixtures/deepseek-missing-result-fixture.mjs', import.meta.url).href;
  const rows = [
    { id: 'timer', name: '@deepseek-ai/cordis-plugin-timer' },
    { id: 'llm', name: '@deepseek-ai/dsh-llm' },
    { id: 'session', name: '@deepseek-ai/dsh-session' },
    { id: 'session-projection', name: '@deepseek-ai/dsh-session-projection' },
    { id: 'system-prompt', name: '@deepseek-ai/dsh-system-prompt', config: {
      includeRuntimeContext: false, includeHarnessIdentity: false, persona: 'Synthetic missing-result fixture' } },
    { id: 'tools', name: '@deepseek-ai/dsh-tools', config: { mode: 'native' } },
    { id: 'agent', name: '@deepseek-ai/dsh-agent' },
    { id: 'agent-loop', name: '@deepseek-ai/dsh-agent-loop', config: { agents: [], maxParallelToolCalls: 2 } },
    { id: 'agent-default-model', name: '@deepseek-ai/dsh-agent-default-model', config: {
      provider: 'reflexmesh-synthetic', model: 'fixture-v1' } },
    { id: 'headless-startup', name: '@deepseek-ai/dsh-headless/startup' },
    { id: 'reflexmesh-observer', name: observer, config: {
      dbPath, tenantId: 'isolated-fixture', scope: 'missing-result', intentMode: 'explicit-summary',
      shutdownResultWaitMs: 0 } },
    { id: 'reflexmesh-missing-result-fixture', name: fixture, config: {
      packageRoot, telemetryPath, homePath, cwdPath, runId } },
  ];
  return `- insert:\n${rows.map(row => `  - ${JSON.stringify(row)}`).join('\n')}\n`
    + '  - id: headless-runner\n'
    + '    name: "@deepseek-ai/dsh-headless"\n'
    + '    inject: [headlessStartup, agentLoop, reflexmeshSyntheticFixtureReady]\n'
    + '    config:\n'
    + '      task: !!js ctx.headlessStartup.task\n';
}

function safeRemove(root) {
  const base = realpathSync(tmpdir());
  const target = realpathSync(root);
  const rel = relative(base, target);
  if (!rel || rel.startsWith('..') || isAbsolute(rel) || rel.includes(sep)
    || !basename(target).startsWith('reflexmesh-missing-result-')) throw new Error('Unsafe cleanup target');
  rmSync(target, { recursive: true, force: false });
  if (existsSync(target)) throw new Error('Probe cleanup incomplete');
}

export function quoteProbeCommandArg(value) {
  if (process.platform === 'win32') return `'${value.replaceAll("'", "''")}'`;
  return `'${value.replaceAll("'", "'\\''")}'`;
}

export function missingResultStartHere({ dbPath, installedRoot, key }) {
  const quote = quoteProbeCommandArg;
  return `# Synthetic missing-result evidence\n\n`
    + `The isolated Agent tool body never returned. The supervisor stopped its child after read-only pre-stop inspection.\n\n`
    + `\`node adapters/evidence-cli.mjs list --db ${quote(dbPath)}\`\n\n`
    + `\`node adapters/evidence-cli.mjs attention --db ${quote(dbPath)}\`\n\n`
    + `\`node adapters/evidence-cli.mjs inspect --db ${quote(dbPath)} --key ${quote(key)}\`\n\n`
    + `\`node adapters/doctor-cli.mjs --deepseek-package-root ${quote(installedRoot)} --db ${quote(dbPath)} --tenant ${quote('isolated-fixture')} --scope ${quote('missing-result')} --key ${quote(key)}\`\n`;
}

export function createProbeRoot(outDir) {
  if (outDir === null) return mkdtempSync(join(tmpdir(), 'reflexmesh-missing-result-'));
  if (typeof outDir !== 'string' || !isAbsolute(outDir) || outDir.length > 4096) {
    throw new Error('output_directory_invalid');
  }
  try { mkdirSync(outDir, { mode: 0o700 }); }
  catch (error) { throw new Error(error?.code === 'EEXIST' ? 'output_directory_exists' : 'output_directory_invalid'); }
  return realpathSync(outDir);
}

function readTelemetry(path) {
  if (statSync(path).size > 8192) throw new Error('Fixture telemetry too large');
  return JSON.parse(readFileSync(path, 'utf8'));
}

export function sameTelemetrySnapshot(before, after) {
  return before !== null && after !== null && JSON.stringify(before) === JSON.stringify(after);
}

export function missingResultFailureReason(signaled, stopped, state) {
  if (!signaled.ok && state.closed && !stopped) return signaled.reason;
  if (!stopped) return 'supervisor_termination_failed';
  if (!signaled.ok) return signaled.reason;
  return state.fault ?? 'evidence_assertion_failed';
}

function readLedger(dbPath, telemetry) {
  const kernel = new SqliteKernel(dbPath, { readOnly: true });
  try {
    const page = kernel.listEvidence({ limit: 2 });
    const item = page.items.length === 1 && page.nextCursor === null ? page.items[0] : null;
    const raw = item ? kernel.inspect(item.key) : null;
    const attention = kernel.listAttention({ limit: 2 });
    const expectedKey = eventKey({ tenantId: 'isolated-fixture', source: 'reflexmesh:missing-result:deepseek-harness',
      id: digest([telemetry.toolSessionId, telemetry.toolAgentId, MISSING_RESULT_CALL_ID, 'before']) });
    const identityBound = item?.key === expectedKey
      && telemetry.toolSessionId === telemetry.modelSessionId
      && telemetry.toolAgentId === telemetry.modelSessionId
      && item?.taskEvidence?.source === 'host-declared'
      && item?.taskEvidence?.recordedStatus === 'ready'
      && item?.taskEvidence?.coverage === 'summary-only'
      && raw?.evidence?.taskEvidence?.scopeDigest === intentDigest({
        harness: 'deepseek-harness', sessionId: telemetry.toolSessionId, agentId: telemetry.toolAgentId })
      && raw?.evidence?.actionDigest === digest({ toolId: MISSING_RESULT_TOOL, args: ARGS });
    const missing = item?.run?.state === 'completed' && item?.run?.mode === 'shadow'
      && item?.hostOutcome?.status === 'missing' && item?.hostOutcome?.count === 0
      && item?.hostOutcome?.byProvenance?.length === 0
      && attention.items.length === 1 && attention.nextCursor === null
      && attention.items[0].key === item.key
      && JSON.stringify(attention.items[0].attention.reasons.map(value => value.code))
        === JSON.stringify(['shadow_outcome_missing']);
    return { identityBound: identityBound === true, missing: missing === true,
      key: item?.key ?? null, runState: item?.run?.state ?? null,
      decisionEffect: item?.decision?.effect ?? null, outcomeStatus: item?.hostOutcome?.status ?? null,
      outcomeCount: item?.hostOutcome?.count ?? null, labels: item?.labelCount ?? null,
      providerId: item?.binding?.providerId ?? null, modelId: item?.binding?.modelId ?? null };
  } finally { kernel.close(); }
}

export function superviseMissingResult(executable, args, { cwd, env, runId, timeoutMs = 30_000 } = {}) {
  const child = spawn(executable, args, { cwd, env, windowsHide: true,
    detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe', 'pipe'] });
  let closed = false, closeCode = null, closeSignal = null, sequence = 0, ipcBuffer = '', stdoutBytes = 0, stderrBytes = 0;
  let fault = null;
  let settleReady;
  const ready = new Promise(resolve => { settleReady = resolve; });
  let readySettled = false;
  const settle = value => { if (!readySettled) { readySettled = true; settleReady(value); } };
  const close = new Promise(resolve => child.once('close', (code, signal) => {
    closed = true; closeCode = code; closeSignal = signal;
    settle({ ok: false, reason: 'host_exited_early' }); resolve();
  }));
  child.once('error', () => settle({ ok: false, reason: 'host_spawn_failed' }));
  const fail = reason => { fault ??= reason; settle({ ok: false, reason }); };
  child.stdout.on('data', chunk => {
    stdoutBytes += chunk.length;
    if (stdoutBytes > 8192) fail('host_stdout_limit_exceeded');
  });
  child.stderr.on('data', chunk => {
    stderrBytes += chunk.length;
    if (stderrBytes > 16_384) fail('host_stderr_limit_exceeded');
  });
  child.stdio[3].on('data', chunk => {
    ipcBuffer += chunk.toString('utf8');
    if (ipcBuffer.length > 4096) { fail('ipc_sequence_invalid'); return; }
    let end;
    while ((end = ipcBuffer.indexOf('\n')) !== -1) {
      const line = ipcBuffer.slice(0, end); ipcBuffer = ipcBuffer.slice(end + 1);
      let value;
      try { value = JSON.parse(line); } catch { fail('ipc_sequence_invalid'); return; }
      if (!validateMissingResultStage(value, runId, sequence)) {
        fail('ipc_sequence_invalid'); return;
      }
      sequence++;
      if (sequence === 3) settle({ ok: true });
    }
  });
  const timer = setTimeout(() => settle({ ok: false, reason: 'host_timeout' }), timeoutMs);
  return { child, ready, close, state: () => ({ closed, closeCode, closeSignal, sequence,
    stdoutBytes, stderrBytes, ipcBuffer, fault }), clearTimer: () => clearTimeout(timer) };
}

export async function terminateExactChild(supervisor) {
  const { child } = supervisor;
  if (!Number.isSafeInteger(child.pid) || child.pid <= 0 || supervisor.state().closed) return false;
  let stopped;
  if (process.platform === 'win32') {
    const result = spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'],
      { windowsHide: true, timeout: 5000, stdio: 'ignore' });
    stopped = result.status === 0;
  } else {
    try { process.kill(-child.pid, 'SIGKILL'); stopped = true; } catch { stopped = false; }
  }
  let timer;
  await Promise.race([supervisor.close, new Promise(resolve => { timer = setTimeout(resolve, 5000); })]);
  clearTimeout(timer);
  return stopped && supervisor.state().closed;
}

export async function runDeepSeekMissingResultProbe(packageRoot, outDir = null) {
  const installed = inspectAgentPackages(packageRoot);
  if (!installed.ok) return failure(installed.reason, installed.hostVersion);
  let root, supervisor, result = failure('isolated_cli_boot_failed', installed.hostVersion);
  const retained = outDir !== null;
  try {
    root = createProbeRoot(outDir);
    const home = join(root, 'home'), cwd = join(root, 'cwd');
    const profile = join(home, 'profiles', PROFILE);
    const dbPath = join(root, 'ledger', 'agent.sqlite');
    const telemetryPath = join(root, 'fixture.json');
    const runId = randomUUID();
    mkdirSync(profile, { recursive: true, mode: 0o700 });
    mkdirSync(cwd, { recursive: true, mode: 0o700 });
    writeFileSync(join(profile, 'package.json'), JSON.stringify({ private: true, type: 'module',
      dsh: { profile: { bundles: [], patchReload: 'startup' } } }), 'utf8');
    writeFileSync(join(profile, 'cordis.patch.yml'), isolatedMissingResultPatch({ packageRoot: installed.root,
      dbPath, telemetryPath, homePath: home, cwdPath: cwd, runId }), 'utf8');
    const env = Object.fromEntries(Object.entries({ DSH_HOME: home, PATH: process.env.PATH,
      SystemRoot: process.env.SystemRoot, WINDIR: process.env.WINDIR, TEMP: root, TMP: root,
    }).filter(([, value]) => typeof value === 'string'));
    supervisor = superviseMissingResult(process.execPath,
      [join(installed.root, 'lib', 'bin.js'), '--profile', PROFILE, MISSING_RESULT_TASK],
      { cwd, env, runId });
    const signaled = await supervisor.ready;
    supervisor.clearTimer();
    let preStop = null, postStop = null, telemetry = null, telemetryStable = false;
    if (signaled.ok && !supervisor.state().closed) {
      telemetry = readTelemetry(telemetryPath);
      preStop = readLedger(dbPath, telemetry);
    }
    const stopped = await terminateExactChild(supervisor);
    if (stopped && signaled.ok && preStop !== null) {
      const afterTelemetry = readTelemetry(telemetryPath);
      postStop = readLedger(dbPath, afterTelemetry);
      telemetryStable = sameTelemetrySnapshot(telemetry, afterTelemetry);
      telemetry = afterTelemetry;
    }
    const stagesValid = signaled.ok && supervisor.state().sequence === 3
      && supervisor.state().ipcBuffer === '' && supervisor.state().fault === null;
    const checks = {
      isolated_profile_and_loader: telemetry?.isolatedProfileLoaded === true
        && telemetry?.observerEntryActivated === true,
      native_body_entered_once: stagesValid && telemetry?.requests === 1 && telemetry?.toolCount === 1
        && telemetry?.toolAdvertised === true && telemetry?.bodyCalls === 1 && telemetry?.toolArgsExact === true,
      official_unload_closed_observer: telemetry?.unloadCompleted === true && telemetry?.unloadFailed === false
        && telemetry?.observerDrainedAtUnload === true && telemetry?.kernelClosedAtUnload === true
        && telemetry?.pendingResultsBeforeUnload === 1
        && telemetry?.pendingBeforeAfterUnload === 0
        && telemetry?.pendingResultsAfterUnload === 0
        && telemetry?.pendingAfterAfterUnload === 0
        && telemetry?.missingResultsAtUnload === 1,
      pre_stop_missing_result: preStop?.missing === true && preStop?.runState === 'completed'
        && preStop?.decisionEffect === 'escalate',
      supervisor_stopped_exact_child: stopped && supervisor.state().closed
        && supervisor.state().closeCode !== 0,
      post_stop_missing_result: telemetryStable && postStop?.missing === true && preStop?.key === postStop?.key
        && preStop?.decisionEffect === postStop?.decisionEffect,
      no_native_result_or_agent_completion: telemetry?.nativeResults === 0
        && telemetry?.agentCompleted === false && telemetry?.naturalBeforeExit === false
        && supervisor.state().stdoutBytes === 0,
      host_identity_and_task_bound: preStop?.identityBound === true && postStop?.identityBound === true,
      zero_labels_and_no_retry: preStop?.labels === 0 && postStop?.labels === 0
        && preStop?.providerId === 'abstain' && preStop?.modelId === 'not-configured'
        && postStop?.providerId === 'abstain' && telemetry?.bodyCalls === 1,
    };
    const assertions = MISSING_RESULT_ASSERTIONS.map(name => ({ name, passed: checks[name] === true }));
    const passed = signaled.ok && stopped && stagesValid && assertions.every(item => item.passed);
    result = { schemaVersion: 1, ...MISSING_RESULT_EVIDENCE,
      agentLoopExercised: passed, nativeToolBodyEntered: passed,
      exitKind: passed ? 'supervisor_terminated' : 'unverified',
      hostVersion: installed.hostVersion, status: passed ? 'passed' : 'failed',
      reason: passed ? 'cli_observer_missing_result_isolated_passed'
        : missingResultFailureReason(signaled, stopped, supervisor.state()),
      assertions: passed ? assertions : MISSING_RESULT_ASSERTIONS.map(name => ({ name, passed: false })),
      preStop, postStop, supervisor: { childPid: supervisor.child.pid ?? null,
        closed: supervisor.state().closed, sequence: supervisor.state().sequence } };
    if (retained) {
      writeFileSync(join(root, 'receipt.json'), JSON.stringify(result, null, 2) + '\n', 'utf8');
      writeFileSync(join(root, 'START-HERE.md'), missingResultStartHere({ dbPath, installedRoot: installed.root,
        key: preStop?.key ?? '' }), 'utf8');
    }
  } catch (error) {
    if (supervisor) {
      supervisor.clearTimer();
      const stopped = supervisor.state().closed || await terminateExactChild(supervisor);
      result = failure(stopped ? 'evidence_assertion_failed' : 'supervisor_termination_failed', installed.hostVersion);
    } else result = failure(error?.message, installed.hostVersion);
  } finally {
    if (root && !retained && (!supervisor || supervisor.state().closed)) {
      try { safeRemove(root); }
      catch { result = failure('isolated_cli_boot_failed', installed.hostVersion); }
    }
  }
  return result;
}

if (isDirectRun(import.meta.url)) {
  const cliArgs = process.argv.slice(2);
  const valid = cliArgs.length === 1 && cliArgs[0]
    || cliArgs.length === 3 && cliArgs[0] && cliArgs[1] === '--out-dir' && cliArgs[2];
  const report = valid
    ? await runDeepSeekMissingResultProbe(cliArgs[0], cliArgs.length === 3 ? cliArgs[2] : null)
    : failure('output_directory_invalid');
  process.stdout.write(`${JSON.stringify(report)}\n`);
  process.exitCode = report.status === 'passed' ? 0 : 1;
}

#!/usr/bin/env node
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, isAbsolute, join, relative, sep } from 'node:path';
import { SqliteKernel, digest } from '../adapters/sqlite-kernel.mjs';
import { eventKey } from '../adapters/durable-mesh.mjs';
import { intentDigest } from '../adapters/task-evidence.mjs';
import { inspectAgentPackages } from '../adapters/deepseek-installation.mjs';
import { isDirectRun } from '../adapters/direct-run.mjs';
import { processFailureReason, runBounded } from './real-host-compat.mjs';
import { TEARDOWN_ASSERTIONS, TEARDOWN_EVIDENCE, TEARDOWN_FAILURES } from './deepseek-teardown-contract.mjs';
import { FENCE_ASSERTIONS, FENCE_EVIDENCE } from './deepseek-fence-contract.mjs';
import { TEARDOWN_MARKER, TEARDOWN_TASK, TEARDOWN_TOOL } from './fixtures/deepseek-teardown-fixture.mjs';

const PROFILE = 'reflexmesh-probe';
const ARGS = Object.freeze({ key: 'synthetic-only' });
const failed = (reason, hostVersion = 'unknown', scenario = 'late-result') => ({ schemaVersion: 1,
  ...(scenario === 'fenced-after' ? FENCE_EVIDENCE : TEARDOWN_EVIDENCE),
  agentLoopExercised: false, hostVersion, status: 'failed',
  reason: TEARDOWN_FAILURES.includes(reason) ? reason : 'evidence_assertion_failed',
  assertions: (scenario === 'fenced-after' ? FENCE_ASSERTIONS : TEARDOWN_ASSERTIONS)
    .map(name => ({ name, passed: false })) });

/** Fixed official runtime rows, with no default bundles, credentials, or model transport. */
export function isolatedTeardownPatch({ packageRoot, dbPath, telemetryPath, homePath, cwdPath,
  scenario = 'late-result' }) {
  if (!['late-result', 'fenced-after'].includes(scenario)) throw new TypeError('Unsupported probe scenario');
  const fenced = scenario === 'fenced-after';
  const product = new URL('../adapters/deepseek-loader-plugin.mjs', import.meta.url).href;
  const fixture = new URL('./fixtures/deepseek-teardown-fixture.mjs', import.meta.url).href;
  const rows = [
    { id: 'timer', name: '@deepseek-ai/cordis-plugin-timer' },
    { id: 'llm', name: '@deepseek-ai/dsh-llm' },
    { id: 'session', name: '@deepseek-ai/dsh-session' },
    { id: 'session-projection', name: '@deepseek-ai/dsh-session-projection' },
    { id: 'system-prompt', name: '@deepseek-ai/dsh-system-prompt', config: {
      includeRuntimeContext: false, includeHarnessIdentity: false, persona: 'Synthetic teardown fixture' } },
    { id: 'tools', name: '@deepseek-ai/dsh-tools', config: { mode: 'native' } },
    { id: 'agent', name: '@deepseek-ai/dsh-agent' },
    { id: 'agent-loop', name: '@deepseek-ai/dsh-agent-loop', config: { agents: [], maxParallelToolCalls: 2 } },
    { id: 'agent-default-model', name: '@deepseek-ai/dsh-agent-default-model', config: {
      provider: 'reflexmesh-synthetic', model: 'fixture-v1' } },
    { id: 'headless-startup', name: '@deepseek-ai/dsh-headless/startup' },
    { id: 'reflexmesh-observer', name: product, config: {
      dbPath, tenantId: 'isolated-fixture', scope: 'teardown', intentMode: 'explicit-summary',
      shutdownResultWaitMs: 0, ...(fenced ? { shutdownDrainWaitMs: 0 } : {}) } },
    { id: 'reflexmesh-teardown-fixture', name: fixture, config: {
      packageRoot, telemetryPath, homePath, cwdPath, ...(fenced ? { scenario } : {}) } },
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
    || !basename(target).startsWith('reflexmesh-teardown-')) throw new Error('Unsafe probe cleanup target');
  rmSync(target, { recursive: true, force: true });
}

export async function runDeepSeekTeardownProbe(packageRoot, scenario = 'late-result') {
  if (!['late-result', 'fenced-after'].includes(scenario)) return failed('evidence_assertion_failed');
  const fenced = scenario === 'fenced-after';
  const installed = inspectAgentPackages(packageRoot);
  if (!installed.ok) return failed(installed.reason, installed.hostVersion, scenario);
  let root, kernel;
  try {
    root = mkdtempSync(join(tmpdir(), 'reflexmesh-teardown-'));
    const home = join(root, 'home');
    const cwd = join(root, 'cwd');
    const profile = join(home, 'profiles', PROFILE);
    const dbPath = join(root, 'ledger', 'agent.sqlite');
    const telemetryPath = join(root, 'fixture.json');
    mkdirSync(profile, { recursive: true, mode: 0o700 });
    mkdirSync(cwd, { recursive: true, mode: 0o700 });
    writeFileSync(join(profile, 'package.json'), JSON.stringify({ private: true, type: 'module',
      dsh: { profile: { bundles: [], patchReload: 'startup' } } }), 'utf8');
    writeFileSync(join(profile, 'cordis.patch.yml'), isolatedTeardownPatch({ packageRoot: installed.root,
      dbPath, telemetryPath, homePath: home, cwdPath: cwd, scenario }), 'utf8');
    const env = Object.fromEntries(Object.entries({
      DSH_HOME: home, PATH: process.env.PATH, SystemRoot: process.env.SystemRoot,
      WINDIR: process.env.WINDIR, TEMP: root, TMP: root,
    }).filter(([, value]) => typeof value === 'string'));
    const child = await runBounded(process.execPath,
      [join(installed.root, 'lib', 'bin.js'), '--profile', PROFILE, TEARDOWN_TASK],
      { cwd, env, timeoutMs: 45_000, stdoutLimitBytes: 8192, stderrLimitBytes: 16_384 });
    if (!child.ok) return failed(processFailureReason(child), installed.hostVersion, scenario);
    let telemetry;
    try { telemetry = JSON.parse(readFileSync(telemetryPath, 'utf8')); }
    catch { return failed('evidence_assertion_failed', installed.hostVersion, scenario); }
    try { kernel = new SqliteKernel(dbPath, { readOnly: true }); }
    catch { return failed('evidence_assertion_failed', installed.hostVersion, scenario); }
    const page = kernel.listEvidence({ limit: 2 });
    const item = page.items.length === 1 && page.nextCursor === null ? page.items[0] : null;
    const raw = item ? kernel.inspect(item.key) : null;
    const attention = kernel.listAttention({ limit: 2 });
    const scope = { harness: 'deepseek-harness', sessionId: telemetry.toolSessionId,
      agentId: telemetry.toolAgentId };
    const expectedKey = eventKey({ tenantId: 'isolated-fixture', source: 'reflexmesh:teardown:deepseek-harness',
      id: digest([telemetry.toolSessionId, telemetry.toolAgentId, 'teardown-call-1', 'before']) });
    const common = {
      isolated_cli_profile_and_loader: telemetry.isolatedProfileLoaded === true
        && telemetry.observerEntryActivated === true && item?.run.mode === 'shadow',
      host_identity_and_task_bound: item?.key === expectedKey
        && telemetry.toolAgentId === telemetry.toolSessionId
        && telemetry.toolSessionId === telemetry.modelSessionId
        && item.taskEvidence.source === 'host-declared'
        && item.taskEvidence.recordedStatus === 'ready'
        && item.taskEvidence.recordedFreshness === 'within_ttl'
        && item.taskEvidence.coverage === 'summary-only'
        && item.taskEvidence.summaryDigest !== null
        && raw?.evidence?.taskEvidence?.scopeDigest === intentDigest(scope)
        && raw?.evidence?.actionDigest === digest({ toolId: TEARDOWN_TOOL, args: ARGS }),
      missing_result_remains_missing: item?.hostOutcome.status === 'missing'
        && item.hostOutcome.count === 0 && item.hostOutcome.byProvenance?.length === 0
        && attention.items.length === 1 && attention.nextCursor === null
        && attention.items[0].key === item.key
        && JSON.stringify(attention.items[0].attention.reasons.map(reason => reason.code))
          === JSON.stringify(['shadow_outcome_missing']),
    };
    const checks = fenced ? {
      isolated_cli_profile_and_loader: common.isolated_cli_profile_and_loader,
      native_tool_result_delivered: telemetry.requests === 2 && telemetry.toolCount === 1
        && telemetry.toolAdvertised === true && telemetry.bodyCalls === 1
        && telemetry.toolArgsExact === true && telemetry.nativeResults === 1
        && telemetry.resultBeforeUnload === true && telemetry.observerDisabledAtResult === false,
      admission_recorded_before_unload: telemetry.afterEntered === true
        && common.host_identity_and_task_bound,
      after_pending_at_unload: telemetry.afterPendingAtUnloadStart === true,
      fenced_unload_completed: telemetry.unloadCompleted === true
        && telemetry.unloadFailed === false && telemetry.observerDrainedAtUnload === false
        && telemetry.kernelClosedAtUnload === true && telemetry.storageRevokedAtUnload === true
        && telemetry.detachedAfterAtUnload === 1 && telemetry.missingResultsAtUnload === 0,
      late_storage_write_rejected: telemetry.lateAttemptObserved === true
        && telemetry.lateWriteRejected === true,
      missing_shadow_outcome_retained: common.missing_result_remains_missing,
      agent_received_result_without_retry: telemetry.resultInModel === true
        && telemetry.bodyCalls === 1 && telemetry.nativeResults === 1
        && child.stdout.trim() === TEARDOWN_MARKER,
      zero_labels_and_no_remote_model: item?.binding.providerId === 'abstain'
        && item.binding.modelId === 'not-configured' && item.labelCount === 0,
      natural_host_exit: telemetry.naturalBeforeExit === true
        && telemetry.observerDrainedAtExit === false && telemetry.kernelClosedAtExit === true,
    } : {
      isolated_cli_profile_and_loader: common.isolated_cli_profile_and_loader,
      native_agent_tool_body_entered: telemetry.requests === 2 && telemetry.toolCount === 1
        && telemetry.toolAdvertised === true && telemetry.bodyCalls === 1
        && telemetry.toolArgsExact === true && typeof telemetry.modelSessionId === 'string',
      loader_unloaded_before_native_result: telemetry.unloadCompleted === true
        && telemetry.unloadFailed === false && telemetry.resultBeforeUnload === false,
      observer_drained_and_kernel_closed: telemetry.observerDrainedAtUnload === true
        && telemetry.kernelClosedAtUnload === true && telemetry.missingResultsAtUnload === 1,
      missing_result_remains_missing: common.missing_result_remains_missing,
      late_native_result_and_agent_completion: telemetry.nativeResults === 1
        && telemetry.observerDisabledAtResult === true && telemetry.resultInModel === true
        && child.stdout.trim() === TEARDOWN_MARKER,
      host_identity_and_task_bound: common.host_identity_and_task_bound,
      zero_labels_and_no_retry: item?.binding.providerId === 'abstain'
        && item.binding.modelId === 'not-configured' && item.labelCount === 0
        && telemetry.bodyCalls === 1 && telemetry.nativeResults === 1,
      natural_host_exit: telemetry.naturalBeforeExit === true
        && telemetry.observerDrainedAtExit === true && telemetry.kernelClosedAtExit === true,
    };
    const assertions = (fenced ? FENCE_ASSERTIONS : TEARDOWN_ASSERTIONS)
      .map(name => ({ name, passed: checks[name] === true }));
    const passed = assertions.every(value => value.passed);
    return { schemaVersion: 1, ...(fenced ? FENCE_EVIDENCE : TEARDOWN_EVIDENCE), agentLoopExercised: passed,
      hostVersion: installed.hostVersion, status: passed ? 'passed' : 'failed',
      reason: passed ? (fenced ? 'cli_observer_fence_passed' : 'cli_observer_teardown_passed')
        : 'evidence_assertion_failed', assertions };
  } catch { return failed('isolated_cli_boot_failed', installed.hostVersion, scenario); }
  finally {
    try { kernel?.close(); }
    catch { return failed('isolated_cli_boot_failed', installed.hostVersion, scenario); }
    if (root) try { safeRemove(root); }
    catch { return failed('isolated_cli_boot_failed', installed.hostVersion, scenario); }
  }
}

if (isDirectRun(import.meta.url)) {
  const report = await runDeepSeekTeardownProbe(process.argv[2], process.argv[3]);
  process.stdout.write(`${JSON.stringify(report)}\n`);
  process.exitCode = report.status === 'passed' ? 0 : 1;
}

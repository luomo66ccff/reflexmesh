#!/usr/bin/env node
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, isAbsolute, join, relative, sep } from 'node:path';
import { SqliteKernel, digest } from '../adapters/sqlite-kernel.mjs';
import { eventKey } from '../adapters/durable-mesh.mjs';
import { intentDigest } from '../adapters/task-evidence.mjs';
import { isDirectRun } from '../adapters/direct-run.mjs';
import { inspectAgentPackages } from '../adapters/deepseek-installation.mjs';
import { processFailureReason, runBounded } from './real-host-compat.mjs';
import { LIFECYCLE_ASSERTIONS, LIFECYCLE_EVIDENCE, LIFECYCLE_FAILURES } from './deepseek-lifecycle-contract.mjs';
import { LIFECYCLE_SCENARIOS, LIFECYCLE_TOOL, lifecycleTask } from './fixtures/deepseek-lifecycle-fixture.mjs';

const PROFILE = 'reflexmesh-probe';
const knownFailure = reason => LIFECYCLE_FAILURES.includes(reason) ? reason : 'evidence_assertion_failed';
const failed = (reason, hostVersion = 'unknown') => ({ schemaVersion: 1, ...LIFECYCLE_EVIDENCE,
  agentLoopExercised: false, hostVersion, status: 'failed', reason: knownFailure(reason),
  assertions: LIFECYCLE_ASSERTIONS.map(name => ({ name, passed: false })) });

/** Fixed official runtime rows, with no default bundles or account/profile inheritance. */
export function isolatedLifecyclePatch({ packageRoot, dbPath, telemetryPath, homePath, cwdPath, scenario }) {
  if (!Object.hasOwn(LIFECYCLE_SCENARIOS, scenario)) throw new TypeError('Unsupported synthetic scenario');
  const product = new URL('../adapters/deepseek-loader-plugin.mjs', import.meta.url).href;
  const fixture = new URL('./fixtures/deepseek-lifecycle-fixture.mjs', import.meta.url).href;
  const rows = [
    { id: 'timer', name: '@deepseek-ai/cordis-plugin-timer' },
    { id: 'llm', name: '@deepseek-ai/dsh-llm' },
    { id: 'session', name: '@deepseek-ai/dsh-session' },
    { id: 'session-projection', name: '@deepseek-ai/dsh-session-projection' },
    { id: 'system-prompt', name: '@deepseek-ai/dsh-system-prompt', config: {
      includeRuntimeContext: false, includeHarnessIdentity: false, persona: 'Synthetic lifecycle fixture' } },
    { id: 'tools', name: '@deepseek-ai/dsh-tools', config: { mode: 'native' } },
    { id: 'agent', name: '@deepseek-ai/dsh-agent' },
    { id: 'agent-loop', name: '@deepseek-ai/dsh-agent-loop', config: { agents: [], maxParallelToolCalls: 2 } },
    { id: 'agent-default-model', name: '@deepseek-ai/dsh-agent-default-model', config: {
      provider: 'reflexmesh-synthetic', model: 'fixture-v1' } },
    { id: 'headless-startup', name: '@deepseek-ai/dsh-headless/startup' },
    { id: 'reflexmesh-observer', name: product, config: {
      dbPath, tenantId: 'isolated-fixture', scope: `lifecycle-${scenario}`, intentMode: 'explicit-summary' } },
    { id: 'reflexmesh-lifecycle-fixture', name: fixture, config: {
      packageRoot, telemetryPath, homePath, cwdPath, scenario } },
  ];
  return `- insert:\n${rows.map(row => `  - ${JSON.stringify(row)}`).join('\n')}\n`
    + '  - id: headless-runner\n'
    + '    name: "@deepseek-ai/dsh-headless"\n'
    + '    inject: [headlessStartup, agentLoop, reflexmeshObserverReady, reflexmeshSyntheticFixtureReady]\n'
    + '    config:\n'
    + '      task: !!js ctx.headlessStartup.task\n';
}

function safeRemove(root) {
  const base = realpathSync(tmpdir());
  const target = realpathSync(root);
  const rel = relative(base, target);
  if (!rel || rel.startsWith('..') || isAbsolute(rel) || rel.includes(sep)
    || !basename(target).startsWith('reflexmesh-lifecycle-')) throw new Error('Unsafe probe cleanup target');
  rmSync(target, { recursive: true, force: true });
}

const receipt = (item, summary, status) => item?.taskEvidence.recordedStatus === 'ready'
  && item.taskEvidence.coverage === 'summary-only' && item.taskEvidence.source === 'host-declared'
  && item.taskEvidence.recordedFreshness === 'within_ttl'
  && item.taskEvidence.summaryDigest === intentDigest(summary)
  && item.hostOutcome.status === status && item.hostOutcome.count === 1
  && item.hostOutcome.byProvenance?.length === 1
  && item.hostOutcome.byProvenance[0].provenance === 'harness-reported'
  && item.hostOutcome.byProvenance[0].status === status;

async function runScenario(installed, scenario) {
  let root, kernel;
  try {
    root = mkdtempSync(join(tmpdir(), 'reflexmesh-lifecycle-'));
    const home = join(root, 'home');
    const cwd = join(root, 'cwd');
    const profile = join(home, 'profiles', PROFILE);
    const dbPath = join(root, 'ledger', 'agent.sqlite');
    const telemetryPath = join(root, 'fixture.json');
    mkdirSync(profile, { recursive: true, mode: 0o700 });
    mkdirSync(cwd, { recursive: true, mode: 0o700 });
    writeFileSync(join(profile, 'package.json'), JSON.stringify({ private: true, type: 'module',
      dsh: { profile: { bundles: [], patchReload: 'startup' } } }), 'utf8');
    writeFileSync(join(profile, 'cordis.patch.yml'), isolatedLifecyclePatch({ packageRoot: installed.root,
      dbPath, telemetryPath, homePath: home, cwdPath: cwd, scenario }), 'utf8');
    const env = Object.fromEntries(Object.entries({
      DSH_HOME: home, PATH: process.env.PATH, SystemRoot: process.env.SystemRoot,
      WINDIR: process.env.WINDIR, TEMP: root, TMP: root,
    }).filter(([, value]) => typeof value === 'string'));
    const child = await runBounded(process.execPath,
      [join(installed.root, 'lib', 'bin.js'), '--profile', PROFILE, lifecycleTask(scenario)],
      { cwd, env, timeoutMs: 45_000, stdoutLimitBytes: 8192, stderrLimitBytes: 16_384 });
    if (!child.ok) return { failure: processFailureReason(child) };
    let telemetry;
    try { telemetry = JSON.parse(readFileSync(telemetryPath, 'utf8')); }
    catch { return { failure: 'evidence_assertion_failed' }; }
    try { kernel = new SqliteKernel(dbPath, { readOnly: true }); }
    catch { return { failure: 'evidence_assertion_failed' }; }
    const expectedIds = scenario === 'parallel'
      ? ['parallel-old-a', 'parallel-old-b', 'parallel-new'] : ['cancel-old', 'cancel-new'];
    const expectedKeys = scenario === 'parallel' ? ['old-a', 'old-b', 'new'] : ['cancel-old', 'new'];
    const page = kernel.listEvidence({ limit: 4 });
    const rowsExact = page.items.length === expectedIds.length && page.nextCursor === null;
    const keyOf = callId => eventKey({ tenantId: 'isolated-fixture', source: `reflexmesh:lifecycle-${scenario}:deepseek-harness`,
      id: digest([telemetry.modelSessionId, telemetry.modelSessionId, callId, 'before']) });
    const items = Object.fromEntries(expectedIds.map(id => [id, kernel.evidenceSnapshot(keyOf(id))]));
    const scopeDigest = intentDigest({ harness: 'deepseek-harness',
      sessionId: telemetry.modelSessionId, agentId: telemetry.agentId });
    const exactCallMetadata = expectedIds.every((id, index) => {
      const item = items[id];
      if (!item) return false;
      const raw = kernel.inspect(item.key);
      return item.key === keyOf(id) && item.run.mode === 'shadow'
        && item.binding.providerId === 'abstain' && item.binding.modelId === 'not-configured'
        && raw?.evidence?.taskEvidence?.scopeDigest === scopeDigest
        && raw?.evidence?.actionDigest === digest({ toolId: LIFECYCLE_TOOL,
          args: { key: expectedKeys[index] } });
    });
    const oldSummary = LIFECYCLE_SCENARIOS[scenario].oldSummary;
    const newSummary = LIFECYCLE_SCENARIOS[scenario].newSummary;
    const oldA = items[expectedIds[0]], oldB = scenario === 'parallel' ? items[expectedIds[1]] : null;
    const current = items[expectedIds.at(-1)];
    const identity = typeof telemetry.modelSessionId === 'string' && telemetry.modelSessionId.length > 0
      && telemetry.agentId === telemetry.modelSessionId && telemetry.toolAgentConsistent === true;
    const shared = {
      isolated: telemetry.profileLoaded === true && telemetry.observerLoaded === true,
      loop: rowsExact && exactCallMetadata && identity && telemetry.requests === 3 && telemetry.toolCount === 1
        && child.stdout.trim() === LIFECYCLE_SCENARIOS[scenario].marker,
      drained: telemetry.naturalBeforeExit === true && telemetry.observerDrainedAtExit === true
        && telemetry.kernelClosedAtExit === true,
      labels: page.items.every(item => item.labelCount === 0),
    };
    if (scenario === 'parallel') {
      return { checks: {
        parallel_isolated_profile_and_loader: shared.isolated,
        parallel_synthetic_agent_loop: shared.loop,
        parallel_native_bodies_overlap: telemetry.maxActiveBodies === 2
          && telemetry.bodyCalls?.['old-a'] === 1 && telemetry.bodyCalls?.['old-b'] === 1,
        parallel_reverse_body_settlement: JSON.stringify(telemetry.bodySettlementOrder) === JSON.stringify(['old-b', 'old-a', 'new'])
          && JSON.stringify(telemetry.resultOrder) === JSON.stringify(expectedIds),
        parallel_native_success_and_failure: rowsExact && receipt(oldA, oldSummary, 'succeeded')
          && receipt(oldB, oldSummary, 'failed')
          && telemetry.results?.[0]?.isError === false && telemetry.results?.[1]?.isError === true,
        parallel_old_task_bound_to_both: rowsExact && identity
          && oldA?.taskEvidence.summaryDigest === oldB?.taskEvidence.summaryDigest
          && Number.isSafeInteger(telemetry.oldClaimTurn) && telemetry.oldClaimTurn >= 1
          && Number.isSafeInteger(telemetry.newClaimTurn) && telemetry.newClaimTurn >= 1
          && telemetry.oldClaimTurn === telemetry.newClaimTurn,
        parallel_steer_new_task_and_digest: rowsExact && receipt(current, newSummary, 'succeeded')
          && current.taskEvidence.summaryDigest !== oldA?.taskEvidence.summaryDigest
          && telemetry.steerCount === 1 && telemetry.newClaimCount === 1
          && telemetry.newMessageInRequest === true && telemetry.oldResultsInRequest === true
          && telemetry.newResultInRequest === true && telemetry.bodyCalls?.new === 1,
        parallel_zero_labels: shared.labels,
        parallel_natural_exit_and_drain: shared.drained,
      } };
    }
    return { checks: {
      cancel_isolated_profile_and_loader: shared.isolated,
      cancel_synthetic_agent_loop: shared.loop,
      cancel_started_body_returned_success: telemetry.cancelBodyStarted === true
        && telemetry.cancelBodyReturnedSuccess === true && telemetry.bodyCalls?.['cancel-old'] === 1,
      cancel_native_aborted_result: telemetry.cancelSignalAborted === true
        && telemetry.results?.[0]?.callId === 'cancel-old' && telemetry.results[0].isError === true
        && telemetry.results[0].code === 'ABORTED',
      cancel_unknown_outcome_no_retry: rowsExact && receipt(oldA, oldSummary, 'unknown')
        && telemetry.bodyCalls?.['cancel-old'] === 1 && telemetry.resultOrder?.filter(id => id === 'cancel-old').length === 1,
      cancel_followup_new_turn_and_digest: rowsExact && receipt(current, newSummary, 'succeeded')
        && current.taskEvidence.summaryDigest !== oldA?.taskEvidence.summaryDigest
        && telemetry.followupQueued === true
        && telemetry.newClaimCount === 1
        && Number.isSafeInteger(telemetry.oldClaimTurn) && telemetry.oldClaimTurn >= 1
        && Number.isSafeInteger(telemetry.newClaimTurn) && telemetry.newClaimTurn >= 1
        && telemetry.newClaimTurn > telemetry.oldClaimTurn
        && telemetry.turnEnds?.some(value => value.turn === telemetry.oldClaimTurn
          && value.kind === 'aborted' && value.cause === 'user')
        && telemetry.turnEnds?.some(value => value.turn === telemetry.newClaimTurn && value.kind === 'completed')
        && telemetry.newMessageInRequest === true && telemetry.newResultInRequest === true
        && telemetry.bodyCalls?.new === 1,
      cancel_zero_labels: shared.labels,
      cancel_natural_exit_and_drain: shared.drained,
    } };
  } catch { return { failure: 'isolated_cli_boot_failed' }; }
  finally {
    try { kernel?.close(); }
    catch { return { failure: 'isolated_cli_boot_failed' }; }
    if (root) try { safeRemove(root); }
    catch { return { failure: 'isolated_cli_boot_failed' }; }
  }
}

export async function runDeepSeekLifecycleProbe(packageRoot) {
  const installed = inspectAgentPackages(packageRoot);
  if (!installed.ok) return failed(installed.reason, installed.hostVersion);
  const checks = {};
  for (const scenario of ['parallel', 'cancel']) {
    const result = await runScenario(installed, scenario);
    if (result.failure) return failed(result.failure, installed.hostVersion);
    Object.assign(checks, result.checks);
  }
  const assertions = LIFECYCLE_ASSERTIONS.map(name => ({ name, passed: checks[name] === true }));
  const passed = assertions.every(item => item.passed);
  return { schemaVersion: 1, ...LIFECYCLE_EVIDENCE, agentLoopExercised: passed,
    hostVersion: installed.hostVersion, status: passed ? 'passed' : 'failed',
    reason: passed ? 'cli_lifecycle_matrix_passed' : 'evidence_assertion_failed', assertions };
}

if (isDirectRun(import.meta.url)) {
  const report = await runDeepSeekLifecycleProbe(process.argv[2]);
  process.stdout.write(`${JSON.stringify(report)}\n`);
  process.exitCode = report.status === 'passed' ? 0 : 1;
}

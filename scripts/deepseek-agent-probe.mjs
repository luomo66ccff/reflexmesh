#!/usr/bin/env node
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, isAbsolute, join, relative, sep } from 'node:path';
import { SqliteKernel } from '../adapters/sqlite-kernel.mjs';
import { intentDigest } from '../adapters/task-evidence.mjs';
import { isDirectRun } from '../adapters/direct-run.mjs';
import { AGENT_ASSERTIONS, AGENT_EVIDENCE, AGENT_FAILURES } from './deepseek-agent-contract.mjs';
import { processFailureReason, runBounded } from './real-host-compat.mjs';
import { FIXTURE_MARKER } from './fixtures/deepseek-agent-fixture.mjs';
import { inspectAgentPackages } from '../adapters/deepseek-installation.mjs';
import { loaderInsert } from '../adapters/doctor.mjs';

export { inspectAgentPackages } from '../adapters/deepseek-installation.mjs';
const PROFILE = 'reflexmesh-probe';
const TASK = 'ReflexMesh-Intent: Verify isolated synthetic agent tool result\nUse only the fixed fixture tool.';
const failed = (reason, hostVersion = 'unknown') => ({ schemaVersion: 1, ...AGENT_EVIDENCE,
  agentLoopExercised: false, hostVersion, status: 'failed',
  reason: AGENT_FAILURES.includes(reason) ? reason : 'evidence_assertion_failed',
  assertions: AGENT_ASSERTIONS.map(name => ({ name, passed: false })) });

export function observerOverlay(dbPath) {
  return loaderInsert({ dbPath, tenantId: 'isolated-fixture', scope: 'agent-probe',
    intentMode: 'explicit-summary' }).yamlInsert;
}

/** JSON flow rows are valid YAML; only the official lazy task expression needs a YAML tag. */
export function isolatedPatch({ packageRoot, telemetryPath, homePath, cwdPath, overlayPath }) {
  const fixture = new URL('./fixtures/deepseek-agent-fixture.mjs', import.meta.url).href;
  const rows = [
    { id: 'timer', name: '@deepseek-ai/cordis-plugin-timer' },
    { id: 'llm', name: '@deepseek-ai/dsh-llm' },
    { id: 'session', name: '@deepseek-ai/dsh-session' },
    { id: 'session-projection', name: '@deepseek-ai/dsh-session-projection' },
    { id: 'system-prompt', name: '@deepseek-ai/dsh-system-prompt', config: {
      includeRuntimeContext: false, includeHarnessIdentity: false, persona: 'Synthetic ReflexMesh compatibility fixture' } },
    { id: 'tools', name: '@deepseek-ai/dsh-tools', config: { mode: 'native' } },
    { id: 'agent', name: '@deepseek-ai/dsh-agent' },
    { id: 'agent-loop', name: '@deepseek-ai/dsh-agent-loop', config: { agents: [], maxParallelToolCalls: 2 } },
    { id: 'agent-default-model', name: '@deepseek-ai/dsh-agent-default-model', config: {
      provider: 'reflexmesh-synthetic', model: 'fixture-v1' } },
    { id: 'headless-startup', name: '@deepseek-ai/dsh-headless/startup' },
    { id: 'reflexmesh-synthetic-fixture', name: fixture, config: {
      packageRoot, telemetryPath, homePath, cwdPath, overlayPath } },
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
  if (!rel || rel.startsWith('..') || isAbsolute(rel) || rel.includes(sep) || !basename(target).startsWith('reflexmesh-agent-')) {
    throw new Error('Unsafe probe cleanup target');
  }
  rmSync(target, { recursive: true, force: true });
}

export async function runDeepSeekAgentProbe(packageRoot) {
  const installed = inspectAgentPackages(packageRoot);
  if (!installed.ok) return failed(installed.reason, installed.hostVersion);
  let root, kernel;
  try {
    root = mkdtempSync(join(tmpdir(), 'reflexmesh-agent-'));
    const home = join(root, 'home');
    const cwd = join(root, 'cwd');
    const profile = join(home, 'profiles', PROFILE);
    const dbPath = join(root, 'ledger', 'agent.sqlite');
    const telemetryPath = join(root, 'fixture.json');
    const overlayPath = join(root, 'observer.patch.yml');
    mkdirSync(profile, { recursive: true, mode: 0o700 });
    mkdirSync(cwd, { recursive: true, mode: 0o700 });
    writeFileSync(join(profile, 'package.json'), JSON.stringify({ private: true, type: 'module',
      dsh: { profile: { bundles: [], patchReload: 'startup' } } }), 'utf8');
    writeFileSync(join(profile, 'cordis.patch.yml'), isolatedPatch({ packageRoot: installed.root,
      telemetryPath, homePath: home, cwdPath: cwd, overlayPath }), 'utf8');
    writeFileSync(overlayPath, observerOverlay(dbPath), { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    const env = Object.fromEntries(Object.entries({
      DSH_HOME: home, PATH: process.env.PATH, SystemRoot: process.env.SystemRoot,
      WINDIR: process.env.WINDIR, TEMP: root, TMP: root,
    }).filter(([, value]) => typeof value === 'string'));
    const child = await runBounded(process.execPath, [join(installed.root, 'lib', 'bin.js'),
      '--profile', PROFILE, '--patch', overlayPath, TASK], {
      cwd, env, timeoutMs: 45_000, stdoutLimitBytes: 8192, stderrLimitBytes: 16_384,
    });
    if (!child.ok) return failed(processFailureReason(child), installed.hostVersion);
    let telemetry;
    try { telemetry = JSON.parse(readFileSync(telemetryPath, 'utf8')); }
    catch { return failed('evidence_assertion_failed', installed.hostVersion); }
    try { kernel = new SqliteKernel(dbPath, { readOnly: true }); }
    catch { return failed('evidence_assertion_failed', installed.hostVersion); }
    const page = kernel.listEvidence({ limit: 2 });
    const item = page.items.length === 1 && page.nextCursor === null ? page.items[0] : null;
    const raw = item ? kernel.inspect(item.key) : null;
    const scope = { harness: 'deepseek-harness', sessionId: telemetry.toolSessionId, agentId: telemetry.toolAgentId };
    const checks = {
      isolated_cli_profile_loaded: telemetry.isolatedProfileLoaded === true && telemetry.loaderProfileBound === true,
      observer_loaded_by_loader: telemetry.observerEntryActivated === true && item !== null && item.run.mode === 'shadow',
      observer_overlay_via_cli: telemetry.observerOverlayViaCli === true,
      native_agent_loop_exercised: telemetry.requests === 2 && telemetry.bodyCalls === 1 && typeof telemetry.modelSessionId === 'string',
      synthetic_adapter_only: telemetry.requests === 2 && item?.binding.providerId === 'abstain'
        && item?.binding.modelId === 'not-configured',
      host_identity_bound: telemetry.toolAgentId === telemetry.modelSessionId
        && telemetry.toolSessionId === telemetry.modelSessionId
        && item?.taskEvidence.source === 'host-declared'
        && item?.taskEvidence.recordedFreshness === 'within_ttl'
        && item?.taskEvidence.summaryDigest !== null
        && raw?.evidence?.taskEvidence?.scopeDigest === intentDigest(scope),
      selected_task_receipt_ready: item?.taskEvidence.recordedStatus === 'ready'
        && item?.taskEvidence.coverage === 'summary-only',
      agent_dispatched_fixture_tool: telemetry.bodyCalls === 1 && telemetry.toolAdvertised === true,
      native_tool_result_correlated: telemetry.toolResultSeen === true && item?.hostOutcome.status === 'succeeded'
        && item?.hostOutcome.count === 1,
      final_marker_from_agent: child.stdout.trim() === FIXTURE_MARKER,
      observer_drained_before_exit: telemetry.naturalBeforeExit === true
        && telemetry.observerDrainedAtExit === true && telemetry.kernelClosedAtExit === true
        && item?.hostOutcome.count === 1 && item?.hostOutcome.byProvenance?.[0]?.provenance === 'harness-reported',
      fixture_tool_scope_enforced: telemetry.toolHadAgent === true && telemetry.toolArgsExact === true
        && telemetry.sessionConsistent === true && telemetry.toolCount === 1,
      zero_labels: item?.labelCount === 0,
    };
    // Do not report arbitrary child fields: only the fixed contract names and booleans leave this process.
    const assertions = AGENT_ASSERTIONS.map(name => ({ name, passed: checks[name] === true }));
    const passed = assertions.every(value => value.passed);
    return { schemaVersion: 1, ...AGENT_EVIDENCE, agentLoopExercised: passed,
      hostVersion: installed.hostVersion, status: passed ? 'passed' : 'failed',
      reason: passed ? 'cli_agent_loop_passed' : 'evidence_assertion_failed', assertions };
  } catch {
    return failed('isolated_cli_boot_failed', installed.hostVersion);
  } finally {
    try { kernel?.close(); }
    catch { return failed('isolated_cli_boot_failed', installed.hostVersion); }
    if (root) {
      try { safeRemove(root); }
      catch { return failed('isolated_cli_boot_failed', installed.hostVersion); }
    }
  }
}

if (isDirectRun(import.meta.url)) {
  const report = await runDeepSeekAgentProbe(process.argv[2]);
  process.stdout.write(`${JSON.stringify(report)}\n`);
  process.exitCode = report.status === 'passed' ? 0 : 1;
}

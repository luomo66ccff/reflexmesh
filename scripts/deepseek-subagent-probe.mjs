#!/usr/bin/env node
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, sep } from 'node:path';
import { SqliteKernel, digest } from '../adapters/sqlite-kernel.mjs';
import { eventKey } from '../adapters/durable-mesh.mjs';
import { intentDigest } from '../adapters/task-evidence.mjs';
import { isDirectRun } from '../adapters/direct-run.mjs';
import { inspectAgentPackages } from '../adapters/deepseek-installation.mjs';
import { processFailureReason, runBounded } from './real-host-compat.mjs';
import { SUBAGENT_ASSERTIONS, SUBAGENT_EVIDENCE, SUBAGENT_FAILURES } from './deepseek-subagent-contract.mjs';
import { CHILD_SUMMARY, DELEGATE_TOOL, FINAL_MARKER, PARENT_SUMMARY, PARENT_TASK,
  READ_TOOL, SHARED_CALL_ID } from './fixtures/deepseek-subagent-fixture.mjs';

const PROFILE = 'reflexmesh-probe';
const failed = (reason, hostVersion = 'unknown') => ({ schemaVersion: 1, ...SUBAGENT_EVIDENCE,
  agentLoopExercised: false, hostVersion, status: 'failed',
  reason: SUBAGENT_FAILURES.includes(reason) ? reason : 'evidence_assertion_failed',
  assertions: SUBAGENT_ASSERTIONS.map(name => ({ name, passed: false })) });
const regularFile = path => { try { return statSync(path).isFile(); } catch { return false; } };

/** Explicitly pin the three optional official subagent packages before CLI loading. */
export function inspectSubagentPackages(packageRoot) {
  const base = dirname(packageRoot);
  for (const name of ['dsh-subagent', 'dsh-subagent-spawn-in-process', 'dsh-subagent-in-process-driver']) {
    const root = join(base, name);
    let manifest;
    try {
      const path = join(root, 'package.json');
      const stat = statSync(path);
      if (!stat.isFile() || stat.size > 1024 * 1024) return false;
      manifest = JSON.parse(readFileSync(path, 'utf8'));
    } catch { return false; }
    if (manifest?.name !== `@deepseek-ai/${name}` || manifest.version !== '0.1.2-rc.1'
      || !regularFile(join(root, 'lib', 'index.js'))) return false;
  }
  return true;
}

/** An isolated official Loader profile; no base bundle, account, or ambient model route. */
export function isolatedSubagentPatch({ packageRoot, dbPath, telemetryPath, homePath, cwdPath }) {
  const product = new URL('../adapters/deepseek-loader-plugin.mjs', import.meta.url).href;
  const fixture = new URL('./fixtures/deepseek-subagent-fixture.mjs', import.meta.url).href;
  const rows = [
    { id: 'timer', name: '@deepseek-ai/cordis-plugin-timer' },
    { id: 'llm', name: '@deepseek-ai/dsh-llm' },
    { id: 'session', name: '@deepseek-ai/dsh-session' },
    { id: 'session-projection', name: '@deepseek-ai/dsh-session-projection' },
    { id: 'system-prompt', name: '@deepseek-ai/dsh-system-prompt', config: {
      includeRuntimeContext: false, includeHarnessIdentity: false, persona: 'Synthetic subagent fixture' } },
    { id: 'tools', name: '@deepseek-ai/dsh-tools', config: { mode: 'native' } },
    { id: 'agent', name: '@deepseek-ai/dsh-agent' },
    { id: 'agent-loop', name: '@deepseek-ai/dsh-agent-loop', config: { agents: [], maxParallelToolCalls: 2 } },
    { id: 'subagent', name: '@deepseek-ai/dsh-subagent' },
    { id: 'subagent-spawn', name: '@deepseek-ai/dsh-subagent-spawn-in-process' },
    { id: 'agent-default-model', name: '@deepseek-ai/dsh-agent-default-model', config: {
      provider: 'reflexmesh-synthetic', model: 'fixture-v1' } },
    { id: 'headless-startup', name: '@deepseek-ai/dsh-headless/startup' },
    { id: 'reflexmesh-observer', name: product, config: {
      dbPath, tenantId: 'isolated-fixture', scope: 'subagent-isolation', intentMode: 'explicit-summary' } },
    { id: 'reflexmesh-subagent-fixture', name: fixture, config: { packageRoot, telemetryPath, homePath, cwdPath } },
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
    || !basename(target).startsWith('reflexmesh-subagent-')) throw new Error('Unsafe probe cleanup target');
  rmSync(target, { recursive: true, force: true });
}
const expectedKey = (sessionId, callId) => eventKey({ tenantId: 'isolated-fixture',
  source: 'reflexmesh:subagent-isolation:deepseek-harness',
  id: digest([sessionId, sessionId, callId, 'before']) });
const outcome = item => item?.hostOutcome.status === 'succeeded' && item.hostOutcome.count === 1
  && item.hostOutcome.byProvenance?.length === 1
  && item.hostOutcome.byProvenance[0].status === 'succeeded'
  && item.hostOutcome.byProvenance[0].provenance === 'harness-reported';
const ready = (item, summary, source = 'host-declared') => item?.taskEvidence.recordedStatus === 'ready'
  && item.taskEvidence.coverage === 'summary-only'
  && item.taskEvidence.summaryDigest === intentDigest(summary)
  && item.taskEvidence.source === source
  && item.taskEvidence.recordedFreshness === (source === 'model-reported' ? 'unverified' : 'within_ttl');

/** Match one native result to its exact journal observation without exposing output content. */
export function matchSubagentOutcome(entry, hostResult) {
  const observations = entry?.raw?.observations;
  const recorded = observations?.length === 1 ? observations[0] : null;
  return hostResult?.agentId === entry?.agent && hostResult?.callId === entry?.call
    && hostResult?.name === entry?.name && hostResult?.isError === false
    && typeof hostResult?.evidenceDigest === 'string' && /^[a-f0-9]{64}$/.test(hostResult.evidenceDigest)
    && recorded?.id === digest([entry.call, 'outcome'])
    && recorded?.status === 'succeeded' && recorded?.provenance === 'harness-reported'
    && recorded?.evidenceDigest === hostResult.evidenceDigest;
}

export async function runDeepSeekSubagentProbe(packageRoot) {
  const installed = inspectAgentPackages(packageRoot);
  if (!installed.ok) return failed(installed.reason, installed.hostVersion);
  if (!inspectSubagentPackages(installed.root)) return failed('unsupported_package_layout', installed.hostVersion);
  let root, kernel;
  try {
    root = mkdtempSync(join(tmpdir(), 'reflexmesh-subagent-'));
    const home = join(root, 'home'), cwd = join(root, 'cwd');
    const profile = join(home, 'profiles', PROFILE);
    const dbPath = join(root, 'ledger', 'agent.sqlite');
    const telemetryPath = join(root, 'fixture.json');
    mkdirSync(profile, { recursive: true, mode: 0o700 });
    mkdirSync(cwd, { recursive: true, mode: 0o700 });
    writeFileSync(join(profile, 'package.json'), JSON.stringify({ private: true, type: 'module',
      dsh: { profile: { bundles: [], patchReload: 'startup' } } }), 'utf8');
    writeFileSync(join(profile, 'cordis.patch.yml'), isolatedSubagentPatch({ packageRoot: installed.root,
      dbPath, telemetryPath, homePath: home, cwdPath: cwd }), 'utf8');
    const env = Object.fromEntries(Object.entries({ DSH_HOME: home, PATH: process.env.PATH,
      SystemRoot: process.env.SystemRoot, WINDIR: process.env.WINDIR, TEMP: root, TMP: root,
    }).filter(([, value]) => typeof value === 'string'));
    const child = await runBounded(process.execPath,
      [join(installed.root, 'lib', 'bin.js'), '--profile', PROFILE, PARENT_TASK],
      { cwd, env, timeoutMs: 45_000, stdoutLimitBytes: 8192, stderrLimitBytes: 16_384 });
    if (!child.ok) return failed(processFailureReason(child), installed.hostVersion);
    let telemetry;
    try { telemetry = JSON.parse(readFileSync(telemetryPath, 'utf8')); }
    catch { return failed('evidence_assertion_failed', installed.hostVersion); }
    try { kernel = new SqliteKernel(dbPath, { readOnly: true }); }
    catch { return failed('evidence_assertion_failed', installed.hostVersion); }
    const ids = [telemetry.parentId, ...telemetry.childIds];
    const distinct = ids.length === 3 && ids.every(id => typeof id === 'string' && id.length > 0)
      && new Set(ids).size === 3;
    const specs = distinct ? [
      { agent: ids[0], call: SHARED_CALL_ID, name: READ_TOOL, args: { key: 'shared' } },
      { agent: ids[0], call: 'delegate-call', name: DELEGATE_TOOL, args: { kind: 'two-fresh-children' } },
      { agent: ids[0], call: 'parent-after', name: READ_TOOL, args: { key: 'parent-after' } },
      { agent: ids[1], call: SHARED_CALL_ID, name: READ_TOOL, args: { key: 'shared' } },
      { agent: ids[2], call: SHARED_CALL_ID, name: READ_TOOL, args: { key: 'child-declared' } },
    ] : [];
    const page = kernel.listEvidence({ limit: 6 });
    const rowsExact = page.items.length === 5 && page.nextCursor === null && specs.length === 5;
    const entries = specs.map(spec => {
      const key = expectedKey(spec.agent, spec.call);
      const item = kernel.evidenceSnapshot(key);
      return { ...spec, key, item, raw: item ? kernel.inspect(key) : null };
    });
    const [parentRead, delegate, parentAfter, plainChild, declaredChild] = entries;
    const fixedMetadata = rowsExact && entries.every(entry => entry.item?.key === entry.key
      && entry.item.run.mode === 'shadow' && entry.item.binding.providerId === 'abstain'
      && entry.item.binding.modelId === 'not-configured'
      && entry.raw?.evidence?.actionDigest === digest({ toolId: entry.name, args: entry.args }));
    const scoped = fixedMetadata && entries.every(entry => {
      const receipt = entry.raw?.evidence?.taskEvidence;
      const expectedScope = intentDigest({ harness: 'deepseek-harness',
        sessionId: entry.agent, agentId: entry.agent });
      return entry === plainChild ? receipt?.status === 'missing' && !Object.hasOwn(receipt, 'scopeDigest')
        : receipt?.scopeDigest === expectedScope;
    });
    const results = entries.every(entry => telemetry.results?.some(value => matchSubagentOutcome(entry, value)))
      && telemetry.results?.length === 5;
    const bodyCalls = entries.every(entry => telemetry.bodyCalls?.filter(value => value.agentId === entry.agent
      && value.callId === entry.call && value.name === entry.name && value.key === (entry.args.key ?? entry.args.kind)).length === 1)
      && telemetry.bodyCalls?.length === 5;
    const lifecycle = distinct && telemetry.providerSpawnAvailable === true
      && telemetry.childClaims?.length === 2
      && telemetry.childClaims[0]?.id === ids[1] && telemetry.childClaims[0]?.declared === false
      && telemetry.childClaims[1]?.id === ids[2] && telemetry.childClaims[1]?.declared === true
      && telemetry.subagentStarts?.length === 2 && telemetry.subagentEnds?.length === 2
      && telemetry.childOwnership?.length === 2 && telemetry.childOwnership.every(Boolean)
      && telemetry.childGone?.length === 2 && telemetry.childGone.every(Boolean)
      && telemetry.childStops?.length === 2 && telemetry.childStops.every(value => value === 'completed')
      && telemetry.subagentStarts.every((start, index) => start.id === ids[index + 1]
        && start.local === true && telemetry.subagentEnds.some(end => end.id === start.id
          && end.runId === start.runId && end.stopReason === 'completed'));
    const checks = {
      isolated_cli_profile_and_loader: telemetry.profileLoaded === true && telemetry.observerLoaded === true,
      official_spawn_provider_and_lineage: lifecycle,
      synthetic_parent_and_children_completed: telemetry.parentRequests === 3
        && Object.keys(telemetry.childRequests ?? {}).length === 2
        && Object.values(telemetry.childRequests).every(value => value === 2)
        && telemetry.modelToolCountValid === true && telemetry.modelResultsValid === true
        && child.stdout.trim() === FINAL_MARKER,
      same_call_id_distinct_agent_keys: distinct && rowsExact
        && new Set([parentRead?.key, plainChild?.key, declaredChild?.key]).size === 3,
      parent_summary_before_delegation: ready(parentRead?.item, PARENT_SUMMARY)
        && ready(delegate?.item, PARENT_SUMMARY) && telemetry.parentClaims === 1,
      plain_child_did_not_inherit_parent_summary: plainChild?.item?.taskEvidence.recordedStatus === 'missing'
        && plainChild.item.taskEvidence.coverage === 'none' && plainChild.item.taskEvidence.summaryDigest === null,
      declared_child_has_only_child_summary: ready(declaredChild?.item, CHILD_SUMMARY, 'model-reported')
        && declaredChild.raw?.evidence?.taskEvidence?.issuedAt === null
        && declaredChild.raw?.evidence?.taskEvidence?.expiresAt === null
        && declaredChild.item.taskEvidence.summaryDigest !== parentRead?.item?.taskEvidence.summaryDigest,
      parent_summary_unaffected_after_children: ready(parentAfter?.item, PARENT_SUMMARY)
        && parentAfter.item.taskEvidence.summaryDigest === parentRead?.item?.taskEvidence.summaryDigest,
      native_results_and_outcomes_correlated: results && bodyCalls && entries.every(entry => outcome(entry.item)),
      shadow_abstain_scope_and_action_bound: scoped,
      zero_independent_labels: rowsExact && entries.every(entry => entry.item?.labelCount === 0),
      natural_exit_and_observer_drain: telemetry.naturalBeforeExit === true
        && telemetry.observerDrainedAtExit === true && telemetry.kernelClosedAtExit === true,
    };
    const assertions = SUBAGENT_ASSERTIONS.map(name => ({ name, passed: checks[name] === true }));
    const passed = assertions.every(item => item.passed);
    return { schemaVersion: 1, ...SUBAGENT_EVIDENCE, agentLoopExercised: passed,
      hostVersion: installed.hostVersion, status: passed ? 'passed' : 'failed',
      reason: passed ? 'cli_subagent_isolation_passed' : 'evidence_assertion_failed', assertions };
  } catch { return failed('isolated_cli_boot_failed', installed.hostVersion); }
  finally {
    try { kernel?.close(); }
    catch { return failed('isolated_cli_boot_failed', installed.hostVersion); }
    if (root) try { safeRemove(root); }
    catch { return failed('isolated_cli_boot_failed', installed.hostVersion); }
  }
}

if (isDirectRun(import.meta.url)) {
  const report = await runDeepSeekSubagentProbe(process.argv[2]);
  process.stdout.write(`${JSON.stringify(report)}\n`);
  process.exitCode = report.status === 'passed' ? 0 : 1;
}

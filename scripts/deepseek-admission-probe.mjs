#!/usr/bin/env node
import { isAbsolute, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createDeepSeekHostPlugin } from '../adapters/deepseek-host-plugin.mjs';
import { isDirectRun } from '../adapters/direct-run.mjs';
import { TaskAwareBoundary } from '../adapters/task-boundary.mjs';
import { SqliteKernel, digest } from '../adapters/sqlite-kernel.mjs';
import { MockProvider, fromDeepSeekCall, toolPreflightPack } from '../dist/index.js';
import { inspectInstalledPackages } from './deepseek-runtime-probe.mjs';

export const ADMISSION_ASSERTIONS = Object.freeze([
  'installed_native_tool_runtime',
  'same_call_host_results_unchanged',
  'same_call_two_native_bodies',
  'old_admission_and_injected_journal_failure',
  'new_task_idempotency_conflict',
  'old_row_unchanged_without_outcome_or_label',
  'new_call_records_positive_control',
  'observer_drained_and_unmounted',
]);
const VERSION = '0.1.2-rc.1';
const assertion = (name, passed) => ({ name, passed: passed === true });
const version = installed => installed?.hostVersion === VERSION ? VERSION : 'unknown';
const report = (status, reason, hostVersion, checks = {}) => ({
  schemaVersion: 1, evidenceLevel: 'native_tool_outcome_admission',
  agentE2E: false, modelInference: false, classification: 'synthetic_classification',
  hostVersion, status, reason,
  assertions: ADMISSION_ASSERTIONS.map(name => assertion(name, checks[name])),
});
const failed = (reason, hostVersion = 'unknown') => report('failed', reason, hostVersion);

/** Installed Cordis and native ToolRuntime only. No Loader, Agent, model route or profile. */
export async function runDeepSeekAdmissionProbe(packageRoot) {
  if (typeof packageRoot !== 'string' || packageRoot.length === 0 || packageRoot.length > 4096
    || !isAbsolute(packageRoot)) return failed('invalid_arguments');
  const installed = inspectInstalledPackages(packageRoot);
  const hostVersion = version(installed);
  if (!installed.ok) return failed(installed.reason, hostVersion);

  let Context, SystemPrompt, ToolRuntime, defineTool;
  try {
    const at = async base => import(pathToFileURL(join(base, 'lib', 'index.js')).href);
    ({ Context } = await at(installed.packages.cordis.base));
    ({ SystemPrompt } = await at(installed.packages.prompt.base));
    ({ ToolRuntime, defineTool } = await at(installed.packages.tools.base));
    if (typeof Context !== 'function' || !SystemPrompt || !ToolRuntime || typeof defineTool !== 'function') {
      return failed('host_load_failed', hostVersion);
    }
  } catch { return failed('host_load_failed', hostVersion); }

  let ctx, kernel, fiber;
  try {
    ctx = new Context();
    kernel = new SqliteKernel(':memory:');
    const identity = () => ({ sessionId: 'synthetic-session', agentId: 'synthetic-agent' });
    const scope = { harness: 'deepseek-harness', ...identity() };
    const issuedAt = Date.now();
    const intent = id => ({ schemaVersion: 1, id, scope, source: 'host-declared',
      summary: `Synthetic ${id} task`, issuedAt, expiresAt: issuedAt + 60_000 });
    let selected = intent('old');
    let providerCalls = 0, bodyCalls = 0, journalFailures = 0, conflicts = 0, beforeAccepted = 0;
    let afterCalls = 0, observerErrors = 0;
    const provider = new MockProvider(() => {
      providerCalls += 1;
      return { model: 'fixture', answers: { intentMatch: { type: 'noul', noul: 0.99 },
        injection: { type: 'noul', noul: 0 } } };
    });
    const boundary = new TaskAwareBoundary({ kernel, provider, pack: toolPreflightPack,
      binding: { providerId: 'mock', modelId: 'fixture', revision: 'fixture-v1',
        authorizationRevision: 'host-owned-shadow', toolsetRevision: 'host-owned-shadow', calibrationRef: null },
      tenantId: 'synthetic', scope: 'outcome-admission' });
    const observingBoundary = {
      async before(call, selectedIntent) {
        try {
          const admitted = await boundary.before(call, selectedIntent);
          beforeAccepted += 1;
          return admitted;
        } catch (error) {
          if (error?.message === 'Idempotency conflict') conflicts += 1;
          throw error;
        }
      },
      after(call, ...args) {
        afterCalls += 1;
        if (journalFailures === 0) {
          journalFailures += 1;
          throw new Error('synthetic journal failure before write');
        }
        return boundary.after(call, ...args);
      },
    };
    const plugin = createDeepSeekHostPlugin({ boundary: observingBoundary, identity,
      resolveIntent: () => selected, onError: () => { observerErrors += 1; } });
    const input = callId => ({ callId, name: 'synthetic_probe', arguments: {},
      signal: new AbortController().signal });
    const inspect = call => boundary.inspect(fromDeepSeekCall(call, identity()));
    await ctx.plugin(SystemPrompt, { includeHarnessIdentity: false, includeRuntimeContext: false, persona: '' });
    await ctx.plugin(ToolRuntime, { mode: 'native' });
    fiber = await ctx.plugin(plugin);
    const mounted = plugin.mounted;
    ctx.tools.register(defineTool({ name: 'synthetic_probe', description: 'In-memory fixture', parameters: {},
      output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
      async execute() { bodyCalls += 1; return `synthetic-${bodyCalls}`; },
    }));

    const oldCall = input('reused-call');
    const first = await ctx.tools.execute(oldCall);
    await plugin.flush();
    const original = inspect(oldCall);
    const firstAccepted = beforeAccepted === 1 && journalFailures === 1 && afterCalls === 1
      && observerErrors === 1 && providerCalls === 1 && original?.observations?.length === 0
      && original?.labels?.length === 0 && original?.evidence?.taskEvidence?.status === 'ready'
      && original.evidence.taskEvidence.id === 'old';

    selected = intent('new');
    const second = await ctx.tools.execute(input('reused-call'));
    await plugin.flush();
    const afterReuse = inspect(oldCall);
    const bodiesAfterReuse = bodyCalls;
    const conflictSeen = conflicts === 1 && beforeAccepted === 1 && providerCalls === 1
      && observerErrors === 2;
    const unchangedAfterReuse = JSON.stringify(afterReuse) === JSON.stringify(original);

    const freshCall = input('fresh-call');
    const third = await ctx.tools.execute(freshCall);
    await plugin.flush();
    const positive = inspect(freshCall);
    const rows = kernel.listEvidence({ limit: 3 });
    const finalOld = inspect(oldCall);
    await fiber.dispose();
    fiber = null;
    const drained = !plugin.mounted && JSON.stringify(inspect(oldCall)) === JSON.stringify(original);
    const checks = {
      installed_native_tool_runtime: mounted,
      same_call_host_results_unchanged: first?.isError === false && second?.isError === false
        && first.content?.[0]?.text === 'synthetic-1' && second.content?.[0]?.text === 'synthetic-2',
      same_call_two_native_bodies: bodiesAfterReuse === 2,
      old_admission_and_injected_journal_failure: firstAccepted,
      new_task_idempotency_conflict: conflictSeen,
      old_row_unchanged_without_outcome_or_label: unchangedAfterReuse
        && JSON.stringify(finalOld) === JSON.stringify(original)
        && finalOld?.observations?.length === 0 && finalOld?.labels?.length === 0,
      new_call_records_positive_control: third?.isError === false && third.content?.[0]?.text === 'synthetic-3'
        && bodyCalls === 3 && beforeAccepted === 2 && providerCalls === 2 && afterCalls === 2
        && positive?.observations?.length === 1 && positive.observations[0]?.status === 'succeeded'
        && positive.observations[0].provenance === 'harness-reported'
        && positive.observations[0].evidenceDigest === digest(third)
        && positive.evidence?.taskEvidence?.id === 'new'
        && positive.evidence?.actionDigest === digest({ toolId: freshCall.name, args: freshCall.arguments })
        && positive?.labels?.length === 0 && rows.items.length === 2 && rows.nextCursor === null,
      observer_drained_and_unmounted: drained && observerErrors === 2,
    };
    const passed = Object.values(checks).every(Boolean);
    return report(passed ? 'passed' : 'failed', passed ? 'native_admission_isolation_passed' : 'probe_assertion_failed',
      hostVersion, checks);
  } catch { return failed('probe_execution_failed', hostVersion); }
  finally {
    let cleanupFailed = false;
    try { await fiber?.dispose(); } catch { cleanupFailed = true; }
    try { await ctx?.fiber.dispose(); } catch { cleanupFailed = true; }
    try { kernel?.close(); } catch { cleanupFailed = true; }
    if (cleanupFailed) return failed('probe_cleanup_failed', hostVersion);
  }
}

if (isDirectRun(import.meta.url)) {
  const value = await runDeepSeekAdmissionProbe(process.argv.length === 3 ? process.argv[2] : undefined);
  process.stdout.write(`${JSON.stringify(value)}\n`);
  process.exitCode = value.status === 'passed' ? 0 : 1;
}

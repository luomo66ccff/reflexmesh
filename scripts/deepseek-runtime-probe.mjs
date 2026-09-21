#!/usr/bin/env node
import { readFileSync, realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createDeepSeekHostPlugin } from '../adapters/deepseek-host-plugin.mjs';
import { isDirectRun } from '../adapters/direct-run.mjs';
import { TaskAwareBoundary } from '../adapters/task-boundary.mjs';
import { SqliteKernel } from '../adapters/sqlite-kernel.mjs';
import { MockProvider, fromDeepSeekCall, toolPreflightPack } from '../dist/index.js';

const DSH_VERSION = '0.1.2-rc.1';
const CORDIS_VERSION = '4.0.2';
const NAMES = Object.freeze({ dsh: '@deepseek-ai/dsh', tools: '@deepseek-ai/dsh-tools', prompt: '@deepseek-ai/dsh-system-prompt', cordis: '@deepseek-ai/cordis' });
const assertion = (name, passed) => ({ name, passed: passed === true });

function installedPackage(root, directory, name) {
  try {
    const base = directory ? join(dirname(root), directory) : root;
    const manifest = JSON.parse(readFileSync(join(base, 'package.json'), 'utf8'));
    if (manifest.name !== name || typeof manifest.version !== 'string') return null;
    return { base, version: manifest.version };
  } catch { return null; }
}

export function inspectInstalledPackages(packageRoot) {
  let root;
  try { root = realpathSync(packageRoot); }
  catch { return { ok: false, reason: 'host_package_missing', hostVersion: 'unknown' }; }
  const packages = Object.fromEntries(Object.entries(NAMES).map(([key, name]) => [key, installedPackage(root, key === 'dsh' ? null : key === 'tools' ? 'dsh-tools' : key === 'prompt' ? 'dsh-system-prompt' : 'cordis', name)]));
  const hostVersion = packages.dsh?.version ?? 'unknown';
  if (Object.values(packages).some(value => value === null)) return { ok: false, reason: 'host_package_missing', hostVersion };
  if (packages.dsh.version !== DSH_VERSION || packages.tools.version !== DSH_VERSION || packages.prompt.version !== DSH_VERSION || packages.cordis.version !== CORDIS_VERSION) {
    return { ok: false, reason: 'unsupported_host_version', hostVersion };
  }
  return { ok: true, packages, hostVersion };
}

const moduleAt = async (base) => import(pathToFileURL(join(base, 'lib', 'index.js')).href);

export async function runRuntimeProbe(packageRoot) {
  const installed = inspectInstalledPackages(packageRoot);
  const base = { schemaVersion: 1, evidenceLevel: 'native_tool_pipeline', agentE2E: false, classification: 'synthetic_classification', hostVersion: installed.hostVersion };
  if (!installed.ok) return { ...base, status: 'failed', reason: installed.reason, assertions: [assertion('supported_installed_packages', false)] };
  let Context, SystemPrompt, ToolRuntime, defineTool, TOOL_ABORTED_BEFORE_DISPATCH;
  try {
    ({ Context } = await moduleAt(installed.packages.cordis.base));
    ({ SystemPrompt } = await moduleAt(installed.packages.prompt.base));
    ({ ToolRuntime, defineTool, TOOL_ABORTED_BEFORE_DISPATCH } = await moduleAt(installed.packages.tools.base));
  } catch { return { ...base, status: 'failed', reason: 'host_load_failed', assertions: [assertion('host_modules_loaded', false)] }; }

  const ctx = new Context();
  const kernel = new SqliteKernel(':memory:');
  const identity = () => ({ sessionId: 'isolated-session', agentId: 'isolated-agent' });
  const scope = { harness: 'deepseek-harness', ...identity() };
  const issuedAt = Date.now();
  const intent = { schemaVersion: 1, id: 'isolated-task', scope, source: 'host-declared', summary: 'Synthetic isolated tool task', issuedAt, expiresAt: issuedAt + 60_000 };
  const binding = { providerId: 'mock', modelId: 'fixture', revision: 'fixture-v1', authorizationRevision: 'host-owned-shadow', toolsetRevision: 'host-owned-shadow', calibrationRef: null };
  let providerCalls = 0, bodyCalls = 0, failingBodyCalls = 0, observerErrors = 0;
  const provider = new MockProvider(() => {
    providerCalls += 1;
    return { model: 'fixture', answers: { intentMatch: { type: 'noul', noul: 0.99 }, injection: { type: 'noul', noul: 0 } } };
  });
  const boundary = new TaskAwareBoundary({ kernel, provider, binding, pack: toolPreflightPack, tenantId: 'isolated', scope: 'host-probe' });
  let releaseBefore, releaseAfter, signalBefore, signalAfter;
  const beforeGate = new Promise(resolve => { releaseBefore = resolve; });
  const afterGate = new Promise(resolve => { releaseAfter = resolve; });
  const beforeEntered = new Promise(resolve => { signalBefore = resolve; });
  const afterEntered = new Promise(resolve => { signalAfter = resolve; });
  const observingBoundary = {
    before: async (call, ...args) => {
      if (call.callId === 'held-call') { signalBefore(); await beforeGate; }
      return boundary.before(call, ...args);
    },
    after: async (call, ...args) => {
      if (call.callId === 'held-call') { signalAfter(); await afterGate; }
      return boundary.after(call, ...args);
    },
  };
  const plugin = createDeepSeekHostPlugin({ boundary: observingBoundary, identity, resolveIntent: () => intent, onError: () => { observerErrors += 1; } });
  const input = callId => ({ callId, name: 'synthetic_probe', arguments: {}, signal: new AbortController().signal });
  const inspect = call => boundary.inspect(fromDeepSeekCall(call, identity()));
  let fiber;
  try {
    await ctx.plugin(SystemPrompt, { includeHarnessIdentity: false, includeRuntimeContext: false, persona: '' });
    await ctx.plugin(ToolRuntime, { mode: 'native' });
    fiber = await ctx.plugin(plugin);
    const mountedAfterInstall = plugin.mounted;
    ctx.tools.register(defineTool({ name: 'synthetic_probe', description: 'In-memory no-op fixture', parameters: {},
      output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
      async execute() { bodyCalls += 1; return 'ok'; },
    }));
    ctx.tools.register(defineTool({ name: 'synthetic_failure', description: 'In-memory failure fixture', parameters: {},
      output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
      async execute() { failingBodyCalls += 1; throw new Error('synthetic tool failure'); },
    }));

    const firstCall = input('repeat-call');
    const first = await ctx.tools.execute(firstCall);
    await plugin.flush();
    const initial = inspect(firstCall);
    const second = await ctx.tools.execute(input('repeat-call'));
    await plugin.flush();
    const repeated = inspect(firstCall);
    const repeatProviderCalls = providerCalls;
    const repeatBodyCalls = bodyCalls;

    const failedCall = { ...input('failed-call'), name: 'synthetic_failure' };
    const failed = await ctx.tools.execute(failedCall);
    await plugin.flush();
    const failedObservation = inspect(failedCall);

    const cancelController = new AbortController();
    cancelController.abort();
    const cancelledCall = { ...input('cancelled-call'), signal: cancelController.signal };
    const cancelled = await ctx.tools.execute(cancelledCall);
    await plugin.flush();
    const afterCancelBodyCalls = bodyCalls;

    const heldCall = input('held-call');
    const runningHeld = ctx.tools.execute(heldCall);
    await beforeEntered;
    let disposalSettled = false;
    const disposal = Promise.resolve(fiber.dispose()).then(() => { disposalSettled = true; });
    await Promise.resolve();
    const disposalWaitedForPre = !disposalSettled && bodyCalls === afterCancelBodyCalls;
    releaseBefore();
    const heldResult = await runningHeld;
    await afterEntered;
    const disposalWaitedForOutcome = !disposalSettled;
    releaseAfter();
    await disposal;
    const unmountedAfterDispose = !plugin.mounted;
    const heldObservation = inspect(heldCall);
    const afterDisposeProviderCalls = providerCalls;
    const afterDisposeCall = input('after-dispose-call');
    const afterDisposeResult = await ctx.tools.execute(afterDisposeCall);
    const kernelStillOpen = inspect(firstCall)?.observations?.length === 1;

    const assertions = [
      assertion('cordis_plugin_mounted', mountedAfterInstall),
      assertion('cordis_plugin_unmounted', unmountedAfterDispose),
      assertion('task_ready', initial?.evidence?.taskEvidence?.status === 'ready' && initial.evidence.taskEvidence.coverage === 'summary-only'),
      assertion('tool_and_outcome', first.isError === false && initial?.observations?.length === 1 && initial.observations[0]?.status === 'succeeded'),
      assertion('repeat_provider_once', second.isError === false && repeatProviderCalls === 1 && repeated?.observations?.length === 1),
      assertion('repeat_is_not_tool_retry_protection', repeatBodyCalls === 2),
      assertion('accepted_failure_recorded', failed.isError === true && failingBodyCalls === 1 && failedObservation?.observations?.[0]?.status === 'failed'),
      assertion('cancel_skips_body', cancelled.isError === true && cancelled.error?.info?.code === TOOL_ABORTED_BEFORE_DISPATCH && afterCancelBodyCalls === repeatBodyCalls && inspect(cancelledCall) == null),
      assertion('async_disposal_waited', heldResult.isError === false && disposalWaitedForPre && disposalWaitedForOutcome && heldObservation?.observations?.length === 1),
      assertion('post_dispose_unobserved', afterDisposeResult.isError === false && providerCalls === afterDisposeProviderCalls && inspect(afterDisposeCall) == null),
      assertion('caller_kernel_remains_open', kernelStillOpen),
      assertion('no_ground_truth_labels', initial?.labels?.length === 0 && heldObservation?.labels?.length === 0),
      assertion('no_observer_errors', observerErrors === 0),
    ];
    const passed = assertions.every(value => value.passed);
    return { ...base, status: passed ? 'passed' : 'failed', reason: passed ? 'native_tool_pipeline_passed' : 'probe_assertion_failed', assertions };
  } catch {
    return { ...base, status: 'failed', reason: 'probe_execution_failed', assertions: [assertion('native_tool_pipeline_completed', false)] };
  } finally {
    releaseBefore();
    releaseAfter();
    try { await fiber?.dispose(); } catch {}
    try { await ctx.fiber.dispose(); } catch {}
    kernel.close();
  }
}

if (isDirectRun(import.meta.url)) {
  const report = await runRuntimeProbe(process.argv[2]);
  process.stdout.write(`${JSON.stringify(report)}\n`);
  process.exitCode = report.status === 'passed' ? 0 : 1;
}

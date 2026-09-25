import { readFileSync, writeFileSync, writeSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';

export const MISSING_RESULT_TOOL = 'reflexmesh_missing_result_read';
export const MISSING_RESULT_TASK = 'ReflexMesh-Intent: Observe one synthetic native read that does not return\nUse only the fixed fixture tool.';
export const MISSING_RESULT_CALL_ID = 'missing-result-call-1';
const ARGS = { key: 'synthetic-only' };
export const marksNativeAgentCompletion = (session, event, expectedSessionId) =>
  typeof expectedSessionId === 'string' && session?.id === expectedSessionId
    && event?.type === 'turn/end';

const plugin = {
  name: 'reflexmesh-missing-result-fixture',
  inject: ['llm', 'tools'],
  async apply(ctx, config) {
    if (!config || ['packageRoot', 'telemetryPath', 'homePath', 'cwdPath', 'runId']
      .some(name => typeof config[name] !== 'string')) throw new TypeError('Synthetic fixture configuration required');
    const profile = join(config.homePath, 'profiles', 'reflexmesh-probe');
    const manifest = JSON.parse(readFileSync(join(profile, 'package.json'), 'utf8'));
    const profileFile = join(profile, 'cordis.yml');
    const isolatedProfileLoaded = process.env.DSH_HOME === config.homePath && process.cwd() === config.cwdPath
      && Array.isArray(manifest.dsh?.profile?.bundles) && manifest.dsh.profile.bundles.length === 0
      && manifest.dsh.profile.patchReload === 'startup' && ctx.fiber?.entry?.parent?.tree?.filename === profileFile;
    const sibling = name => join(dirname(config.packageRoot), name);
    const [{ LlmAdapter }, { defineTool }] = await Promise.all([
      import(pathToFileURL(join(sibling('dsh-llm'), 'lib', 'index.js')).href),
      import(pathToFileURL(join(sibling('dsh-tools'), 'lib', 'index.js')).href),
    ]);
    const state = { isolatedProfileLoaded, observerEntryActivated: false,
      requests: 0, toolCount: -1, toolAdvertised: false, bodyCalls: 0,
      toolArgsExact: false, modelSessionId: null, toolSessionId: null, toolAgentId: null,
      unloadCompleted: false, unloadFailed: false, observerDrainedAtUnload: false,
      kernelClosedAtUnload: false, missingResultsAtUnload: null, nativeResults: 0,
      pendingResultsBeforeUnload: null, pendingBeforeAfterUnload: null,
      pendingResultsAfterUnload: null, pendingAfterAfterUnload: null,
      agentCompleted: false, naturalBeforeExit: false };
    const save = () => writeFileSync(config.telemetryPath, JSON.stringify(state), 'utf8');
    let sequence = 0;
    const stage = name => writeSync(3, `${JSON.stringify({ runId: config.runId, seq: ++sequence, stage: name })}\n`);
    let observerReady;
    const captureObserver = () => {
      const loader = ctx.get('loader');
      observerReady ??= ctx.get('reflexmeshObserverReady');
      const entry = [...(loader?.entries() ?? [])].find(item => item.options?.id === 'reflexmesh-observer');
      state.observerEntryActivated = entry?.options?.name
        === new URL('../../adapters/deepseek-loader-plugin.mjs', import.meta.url).href
        && entry.fiber?.state === 2 && entry.parent?.tree?.filename === profileFile;
      save();
      if (!state.observerEntryActivated || !observerReady || !entry?.id) throw new Error('Observer activation mismatch');
      return { loader, entry };
    };
    process.once('beforeExit', () => { state.naturalBeforeExit = true; try { save(); } catch {} });
    ctx.on('session/event', (session, event) => {
      if (marksNativeAgentCompletion(session, event, state.toolSessionId)) {
        state.agentCompleted = true;
        save();
      }
    });
    ctx.on('tools/result', (exec) => {
      if (exec?.callId === MISSING_RESULT_CALL_ID) { state.nativeResults++; save(); }
    });
    class SyntheticAdapter extends LlmAdapter {
      async *stream(options) {
        state.requests++;
        options.signal?.throwIfAborted();
        if (options.provider !== 'reflexmesh-synthetic' || options.model !== 'fixture-v1'
          || state.requests !== 1) throw new Error('Unexpected synthetic model request');
        state.modelSessionId = options.sessionId ?? null;
        state.toolCount = Array.isArray(options.tools) ? options.tools.length : -1;
        state.toolAdvertised = state.toolCount === 1 && options.tools[0]?.name === MISSING_RESULT_TOOL;
        save();
        if (!state.toolAdvertised) throw new Error('Synthetic tool missing');
        yield { type: 'tool-call-delta', index: 0, id: MISSING_RESULT_CALL_ID,
          name: MISSING_RESULT_TOOL, argumentsDelta: JSON.stringify(ARGS) };
        yield { type: 'finish', reason: { kind: 'stop' } };
      }
    }
    ctx.llm.registerAdapter(['reflexmesh-synthetic'], new SyntheticAdapter());
    ctx.tools.register(defineTool({
      name: MISSING_RESULT_TOOL, description: 'A fixed synthetic read that never returns',
      parameters: { key: { type: 'string', required: true } },
      output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
      async execute(args, exec) {
        state.bodyCalls++;
        state.toolArgsExact = Object.keys(args).length === 1 && args.key === ARGS.key;
        state.toolSessionId = exec?.agent?.session?.id ?? null;
        state.toolAgentId = exec?.agent?.id ?? null;
        const { loader, entry } = captureObserver();
        save();
        if (!state.toolArgsExact || !state.modelSessionId
          || state.toolSessionId !== state.modelSessionId || state.toolAgentId !== state.toolSessionId) {
          throw new Error('Synthetic tool scope mismatch');
        }
        stage('body_entered');
        setImmediate(() => {
          void (async () => {
            try {
              state.pendingResultsBeforeUnload = observerReady.shutdownDrain.pendingResults;
              save();
              if (state.pendingResultsBeforeUnload !== 1) throw new Error('Pending result window mismatch');
              await loader.update(entry.id, { disabled: true });
              const drain = observerReady.shutdownDrain;
              state.observerDrainedAtUnload = observerReady.observerDrained === true;
              state.kernelClosedAtUnload = observerReady.kernelClosed === true;
              state.missingResultsAtUnload = observerReady.shutdownMissingResults;
              state.pendingBeforeAfterUnload = drain.pendingBefore;
              state.pendingResultsAfterUnload = drain.pendingResults;
              state.pendingAfterAfterUnload = drain.pendingAfter;
              state.unloadCompleted = true;
              save();
              stage('observer_unloaded');
            } catch {
              state.unloadFailed = true;
              save();
              throw new Error('Synthetic observer unload failed');
            }
          })();
        });
        // Keep the process alive independently of the unresolved native body.
        setInterval(() => {}, 1000);
        return new Promise(() => {});
      },
    }));
    ctx.provide('reflexmeshSyntheticFixtureReady', true);
    save();
    stage('fixture_ready');
  },
};
export default plugin;

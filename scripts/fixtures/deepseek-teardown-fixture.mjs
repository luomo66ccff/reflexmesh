import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';

export const TEARDOWN_TOOL = 'reflexmesh_teardown_read';
export const TEARDOWN_MARKER = 'REFLEXMESH_SYNTHETIC_TEARDOWN_OK';
export const TEARDOWN_TASK = 'ReflexMesh-Intent: Verify observer unload during one synthetic in-memory read\nUse only the fixed fixture tool.';
const CALL_ID = 'teardown-call-1';
const VALUE = 'synthetic-teardown-ok';
const PROVIDER = 'reflexmesh-synthetic';
const MODEL = 'fixture-v1';
const ARGS = { key: 'synthetic-only' };

const plugin = {
  name: 'reflexmesh-teardown-fixture',
  // Do not inject observer readiness: this fixture must survive its removal.
  inject: ['llm', 'tools'],
  async apply(ctx, config) {
    if (!config || ['packageRoot', 'telemetryPath', 'homePath', 'cwdPath']
      .some(name => typeof config[name] !== 'string')) throw new TypeError('Synthetic teardown paths required');
    const profile = join(config.homePath, 'profiles', 'reflexmesh-probe');
    const manifest = JSON.parse(readFileSync(join(profile, 'package.json'), 'utf8'));
    const profileFile = join(profile, 'cordis.yml');
    const isolatedProfileLoaded = process.env.DSH_HOME === config.homePath && process.cwd() === config.cwdPath
      && Array.isArray(manifest.dsh?.profile?.bundles) && manifest.dsh.profile.bundles.length === 0
      && manifest.dsh.profile.patchReload === 'startup'
      && ctx.fiber?.entry?.parent?.tree?.filename === profileFile;
    const sibling = name => join(dirname(config.packageRoot), name);
    const [{ LlmAdapter }, { defineTool }] = await Promise.all([
      import(pathToFileURL(join(sibling('dsh-llm'), 'lib', 'index.js')).href),
      import(pathToFileURL(join(sibling('dsh-tools'), 'lib', 'index.js')).href),
    ]);
    const state = {
      isolatedProfileLoaded, observerEntryActivated: false, naturalBeforeExit: false,
      requests: 0, toolCount: -1, bodyCalls: 0, nativeResults: 0,
      modelSessionId: null, toolSessionId: null, toolAgentId: null,
      toolArgsExact: false, toolAdvertised: false, resultInModel: false,
      resultBeforeUnload: false, observerDrainedAtUnload: false,
      kernelClosedAtUnload: false, missingResultsAtUnload: null,
      observerDisabledAtResult: false, observerDrainedAtExit: false,
      kernelClosedAtExit: false, unloadCompleted: false, unloadFailed: false,
    };
    const save = () => writeFileSync(config.telemetryPath, JSON.stringify(state), 'utf8');
    save();
    let observerReady;
    process.once('beforeExit', () => { state.naturalBeforeExit = true; try { save(); } catch {} });
    process.once('exit', () => {
      state.observerDrainedAtExit = observerReady?.observerDrained === true;
      state.kernelClosedAtExit = observerReady?.kernelClosed === true;
      try { save(); } catch {}
    });
    ctx.on('tools/result', (exec, result) => {
      if (exec?.callId !== CALL_ID || exec?.agent?.id !== state.toolAgentId) return;
      state.nativeResults++;
      state.resultBeforeUnload ||= state.unloadCompleted !== true;
      state.observerDisabledAtResult = observerReady?.observerDrained === true
        && observerReady?.kernelClosed === true && result?.isError === false;
      save();
    });
    class SyntheticAdapter extends LlmAdapter {
      async *stream(options) {
        state.requests++;
        options.signal?.throwIfAborted();
        if (options.provider !== PROVIDER || options.model !== MODEL || state.requests > 2) {
          throw new Error('Unexpected synthetic model request');
        }
        state.modelSessionId ??= options.sessionId ?? null;
        state.toolCount = Array.isArray(options.tools) ? options.tools.length : -1;
        state.toolAdvertised = state.toolCount === 1 && options.tools[0]?.name === TEARDOWN_TOOL;
        save();
        if (!state.toolAdvertised || options.sessionId !== state.modelSessionId) {
          throw new Error('Synthetic tool scope mismatch');
        }
        if (state.requests === 1) {
          yield { type: 'tool-call-delta', index: 0, id: CALL_ID,
            name: TEARDOWN_TOOL, argumentsDelta: JSON.stringify(ARGS) };
        } else {
          state.resultInModel = options.messages?.some(message => message.content?.some(block =>
            block.type === 'tool-result' && block.toolCallId === CALL_ID && block.isError === false
            && block.content?.some(part => part.type === 'text' && part.text === VALUE))) === true;
          save();
          if (!state.resultInModel) throw new Error('Late native result missing from Agent');
          yield { type: 'text-delta', index: 0, text: TEARDOWN_MARKER };
        }
        yield { type: 'finish', reason: { kind: 'stop' } };
      }
    }
    ctx.llm.registerAdapter([PROVIDER], new SyntheticAdapter());
    ctx.tools.register(defineTool({
      name: TEARDOWN_TOOL, description: 'Read a fixed in-memory synthetic value',
      parameters: { key: { type: 'string', required: true } },
      output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
      async execute(args, exec) {
        state.bodyCalls++;
        state.toolArgsExact = Object.keys(args).length === 1 && args.key === ARGS.key;
        state.toolSessionId = exec?.agent?.session?.id ?? null;
        state.toolAgentId = exec?.agent?.id ?? null;
        const loader = ctx.get('loader');
        observerReady = ctx.get('reflexmeshObserverReady');
        const entry = [...(loader?.entries() ?? [])].find(item => item.options?.id === 'reflexmesh-observer');
        state.observerEntryActivated = entry?.options?.name
          === new URL('../../adapters/deepseek-loader-plugin.mjs', import.meta.url).href
          && entry.fiber?.state === 2 && entry.parent?.tree?.filename === profileFile;
        save();
        if (!state.toolArgsExact || !state.observerEntryActivated || !observerReady
          || state.toolAgentId !== state.toolSessionId || !entry?.id) {
          throw new Error('Synthetic observer or execution scope mismatch');
        }
        // The native ToolRuntime is awaiting this body, so no tools/result exists yet.
        // Unload only the observer via the official Loader, then release the body.
        let release, reject;
        const gate = new Promise((resolve, fail) => { release = resolve; reject = fail; });
        setImmediate(() => {
          void (async () => {
            try {
              await loader.update(entry.id, { disabled: true });
              state.observerDrainedAtUnload = observerReady.observerDrained === true;
              state.kernelClosedAtUnload = observerReady.kernelClosed === true;
              state.missingResultsAtUnload = observerReady.shutdownMissingResults;
              state.unloadCompleted = true;
              save();
              release();
            } catch {
              state.unloadFailed = true;
              save();
              reject(new Error('Synthetic observer unload failed'));
            }
          })();
        });
        await gate;
        return VALUE;
      },
    }));
    ctx.provide('reflexmeshSyntheticFixtureReady', true);
  },
};

export default plugin;

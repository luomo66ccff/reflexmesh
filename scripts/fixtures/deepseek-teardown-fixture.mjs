import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { TaskAwareBoundary } from '../../adapters/task-boundary.mjs';

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
    if (config.scenario !== undefined && !['fenced-after', 'permanent-before', 'permanent-after'].includes(config.scenario)) {
      throw new TypeError('Unsupported synthetic teardown scenario');
    }
    const fenced = config.scenario === 'fenced-after';
    const permanentBefore = config.scenario === 'permanent-before';
    const permanentAfter = config.scenario === 'permanent-after';
    const pendingAfter = fenced || permanentAfter;
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
      afterEntered: false, afterPendingAtUnloadStart: false,
      storageRevokedAtUnload: false, detachedAfterAtUnload: null,
      lateWriteRejected: false, lateAttemptObserved: false,
      beforeEntered: false, beforePendingAtUnloadStart: false,
      detachedBeforeAtUnload: null, bodyEnteredAfterUnload: false,
    };
    const save = () => writeFileSync(config.telemetryPath, JSON.stringify(state), 'utf8');
    save();
    let observerReady, observerEntryId;
    let releaseAfter, markAfterEntered, markLateAttempt, completeUnload, failUnload;
    const afterGate = new Promise(resolve => { releaseAfter = resolve; });
    const afterEntered = new Promise(resolve => { markAfterEntered = resolve; });
    const lateAttempt = new Promise(resolve => { markLateAttempt = resolve; });
    const unloadDone = new Promise((resolve, reject) => { completeUnload = resolve; failUnload = reject; });
    void unloadDone.catch(() => {});
    const captureObserver = () => {
      const loader = ctx.get('loader');
      observerReady ??= ctx.get('reflexmeshObserverReady');
      const entry = [...(loader?.entries() ?? [])].find(item => item.options?.id === 'reflexmesh-observer');
      observerEntryId = entry?.id;
      state.observerEntryActivated = entry?.options?.name
        === new URL('../../adapters/deepseek-loader-plugin.mjs', import.meta.url).href
        && entry.fiber?.state === 2 && entry.parent?.tree?.filename === profileFile;
      save();
      if (!state.observerEntryActivated || !observerReady || !entry?.id) {
        throw new Error('Synthetic observer activation mismatch');
      }
      return { loader, entry };
    };
    const recordUnload = () => {
      const drain = observerReady.shutdownDrain;
      state.observerDrainedAtUnload = observerReady.observerDrained === true;
      state.kernelClosedAtUnload = observerReady.kernelClosed === true;
      state.missingResultsAtUnload = observerReady.shutdownMissingResults;
      state.storageRevokedAtUnload = observerReady.storageRevoked === true;
      state.detachedBeforeAtUnload = drain.detachedBefore;
      state.detachedAfterAtUnload = drain.detachedAfter;
      state.unloadCompleted = true;
      save();
    };
    // The installed Loader already owns this exact TaskAwareBoundary class.
    // Fixture gates hold its before/after continuation at the built-in seam.
    const originalAfterDescriptor = Object.getOwnPropertyDescriptor(TaskAwareBoundary.prototype, 'after');
    const originalAfter = TaskAwareBoundary.prototype.after;
    const originalBeforeDescriptor = Object.getOwnPropertyDescriptor(TaskAwareBoundary.prototype, 'before');
    const originalBefore = TaskAwareBoundary.prototype.before;
    if (permanentBefore) TaskAwareBoundary.prototype.before = async function(call, ...args) {
      if (call.callId !== CALL_ID) return originalBefore.call(this, call, ...args);
      state.beforeEntered = true;
      save();
      // The native pre-execute waterfall awaits this promise. Schedule unload
      // independently so its progress cannot depend on the tool body running.
      setImmediate(() => {
        void (async () => {
          try {
            const { loader, entry } = captureObserver();
            state.beforePendingAtUnloadStart = observerReady.shutdownDrain.pendingBefore === 1;
            if (!state.beforePendingAtUnloadStart) throw new Error('Synthetic admission did not enter');
            await loader.update(entry.id, { disabled: true });
            recordUnload();
            completeUnload();
          } catch {
            state.unloadFailed = true;
            save();
            failUnload(new Error('Synthetic permanent-before unload failed'));
          }
        })();
      });
      return new Promise(() => {});
    };
    if (pendingAfter) TaskAwareBoundary.prototype.after = async function(call, ...args) {
      if (call.callId !== CALL_ID) return originalAfter.call(this, call, ...args);
      state.afterEntered = true;
      save();
      markAfterEntered();
      if (permanentAfter) return new Promise(() => {});
      await afterGate;
      try { return originalAfter.call(this, call, ...args); }
      catch (error) {
        state.lateWriteRejected = error?.message === 'DeepSeek observer storage revoked';
        throw error;
      } finally {
        state.lateAttemptObserved = true;
        save();
        markLateAttempt();
      }
    };
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
      state.observerDisabledAtResult = observerReady?.kernelClosed === true
        && (observerReady?.observerDrained === true || observerReady?.storageRevoked === true)
        && result?.isError === false;
      save();
      if (pendingAfter && state.nativeResults === 1) setImmediate(() => {
        void (async () => {
          try {
            await afterEntered;
            const loader = ctx.get('loader');
            state.afterPendingAtUnloadStart = observerReady?.shutdownDrain?.pendingAfter === 1;
            if (!observerEntryId || !state.afterPendingAtUnloadStart) {
              throw new Error('Synthetic result storage did not enter');
            }
            await loader.update(observerEntryId, { disabled: true });
            recordUnload();
            if (fenced) {
              releaseAfter();
              await lateAttempt;
            }
            completeUnload();
          } catch {
            state.unloadFailed = true;
            save();
            releaseAfter?.();
            failUnload(new Error('Synthetic fenced unload failed'));
          }
        })();
      });
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
          if (pendingAfter || permanentBefore) await unloadDone;
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
        if (permanentBefore) await unloadDone;
        state.bodyEnteredAfterUnload = state.unloadCompleted === true;
        state.toolArgsExact = Object.keys(args).length === 1 && args.key === ARGS.key;
        state.toolSessionId = exec?.agent?.session?.id ?? null;
        state.toolAgentId = exec?.agent?.id ?? null;
        const observerWasUnloaded = permanentBefore && state.unloadCompleted;
        const { loader, entry } = observerWasUnloaded ? { loader: null, entry: null } : captureObserver();
        save();
        if (!state.toolArgsExact || !state.observerEntryActivated || !observerReady
          || state.toolAgentId !== state.toolSessionId || (!observerWasUnloaded && !entry?.id)) {
          throw new Error('Synthetic observer or execution scope mismatch');
        }
        if (fenced || permanentBefore || permanentAfter) return VALUE;
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
    return () => {
      if (pendingAfter) {
        if (originalAfterDescriptor) Object.defineProperty(TaskAwareBoundary.prototype, 'after', originalAfterDescriptor);
        else delete TaskAwareBoundary.prototype.after;
      }
      if (permanentBefore) {
        if (originalBeforeDescriptor) Object.defineProperty(TaskAwareBoundary.prototype, 'before', originalBeforeDescriptor);
        else delete TaskAwareBoundary.prototype.before;
      }
    };
  },
};

export default plugin;

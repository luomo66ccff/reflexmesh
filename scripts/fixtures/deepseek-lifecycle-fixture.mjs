import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';

export const LIFECYCLE_TOOL = 'reflexmesh_lifecycle_read';
export const LIFECYCLE_SCENARIOS = Object.freeze({
  parallel: Object.freeze({
    oldSummary: 'Parallel fixed in-memory reads', newSummary: 'Steered fixed in-memory read',
    marker: 'REFLEXMESH_SYNTHETIC_PARALLEL_OK',
  }),
  cancel: Object.freeze({
    oldSummary: 'Cancel fixed in-memory read', newSummary: 'Followup fixed in-memory read',
    marker: 'REFLEXMESH_SYNTHETIC_CANCEL_OK',
  }),
});
export const lifecycleTask = scenario => `ReflexMesh-Intent: ${LIFECYCLE_SCENARIOS[scenario].oldSummary}\nSynthetic fixture only.`;
const followupText = scenario => `ReflexMesh-Intent: ${LIFECYCLE_SCENARIOS[scenario].newSummary}\nSynthetic fixture only.`;
const PROVIDER = 'reflexmesh-synthetic';
const MODEL = 'fixture-v1';
const calls = {
  parallel: ['parallel-old-a', 'parallel-old-b', 'parallel-new'],
  cancel: ['cancel-old', 'cancel-new'],
};
const keys = {
  parallel: ['old-a', 'old-b', 'new'],
  cancel: ['cancel-old', 'new'],
};
const deferred = () => {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
};
const messageHas = (options, callId, isError) => options.messages?.some(message => message.content?.some(block =>
  block.type === 'tool-result' && block.toolCallId === callId && block.isError === isError)) === true;

const plugin = {
  name: 'reflexmesh-lifecycle-fixture',
  inject: ['llm', 'tools', 'reflexmeshObserverReady'],
  async apply(ctx, config) {
    if (!config || !Object.hasOwn(LIFECYCLE_SCENARIOS, config.scenario)
      || typeof config.packageRoot !== 'string' || typeof config.telemetryPath !== 'string'
      || typeof config.homePath !== 'string' || typeof config.cwdPath !== 'string') {
      throw new TypeError('Synthetic lifecycle fixture configuration required');
    }
    const scenario = config.scenario;
    const expected = LIFECYCLE_SCENARIOS[scenario];
    const profile = join(config.homePath, 'profiles', 'reflexmesh-probe');
    const manifest = JSON.parse(readFileSync(join(profile, 'package.json'), 'utf8'));
    const profileFile = join(profile, 'cordis.yml');
    const profileLoaded = process.env.DSH_HOME === config.homePath && process.cwd() === config.cwdPath
      && Array.isArray(manifest.dsh?.profile?.bundles) && manifest.dsh.profile.bundles.length === 0
      && manifest.dsh.profile.patchReload === 'startup'
      && ctx.fiber?.entry?.parent?.tree?.filename === profileFile;
    const observerEntry = [...(ctx.get('loader')?.entries() ?? [])].find(entry => entry.options?.id === 'reflexmesh-observer');
    const observerLoaded = observerEntry?.options?.name === new URL('../../adapters/deepseek-loader-plugin.mjs', import.meta.url).href
      && observerEntry.fiber?.state === 2 && observerEntry.parent?.tree?.filename === profileFile;
    const observerReady = ctx.get('reflexmeshObserverReady');
    const sibling = name => join(dirname(config.packageRoot), name);
    const [{ LlmAdapter, createUserMessage }, { defineTool }] = await Promise.all([
      import(pathToFileURL(join(sibling('dsh-llm'), 'lib', 'index.js')).href),
      import(pathToFileURL(join(sibling('dsh-tools'), 'lib', 'index.js')).href),
    ]);
    const state = {
      profileLoaded, observerLoaded, naturalBeforeExit: false, observerDrainedAtExit: false,
      kernelClosedAtExit: false, requests: 0, toolCount: -1, modelSessionId: null,
      agentId: null, oldClaimTurn: null, newClaimTurn: null, newMessageInRequest: false,
      newClaimCount: 0, steerCount: 0,
      oldResultsInRequest: false, newResultInRequest: false, resultOrder: [], results: [],
      bodyCalls: {}, activeBodies: 0, maxActiveBodies: 0, bodySettlementOrder: [],
      cancelBodyStarted: false, cancelBodyReturnedSuccess: false, cancelSignalAborted: false,
      followupQueued: false, turnEnds: [], toolAgentConsistent: true,
    };
    const save = () => writeFileSync(config.telemetryPath, JSON.stringify(state), 'utf8');
    save();
    process.once('beforeExit', () => { state.naturalBeforeExit = true; try { save(); } catch {} });
    process.once('exit', () => {
      state.observerDrainedAtExit = observerReady?.observerDrained === true;
      state.kernelClosedAtExit = observerReady?.kernelClosed === true;
      try { save(); } catch {}
    });

    const releaseA = deferred();
    const bothEntered = deferred();
    const cancelEntered = deferred();
    const releaseCancel = deferred();
    if (scenario === 'cancel') void cancelEntered.promise.then(exec => {
      exec.agent.cancel({ kind: 'user' });
      state.cancelSignalAborted = exec.signal.aborted === true;
      exec.agent.followup(createUserMessage({ content: [{ type: 'text', text: followupText(scenario) }],
        source: { kind: 'user' } }));
      state.followupQueued = true;
      save();
      releaseCancel.resolve();
    });

    ctx.on('agent/inbox/claimed', ({ agent, message, turn } = {}) => {
      if (message?.source?.kind !== 'user' || message.role !== 'user') return;
      const text = message.content?.[0]?.type === 'text' ? message.content[0].text : null;
      if (text === lifecycleTask(scenario)) {
        state.agentId = agent?.id ?? null;
        state.oldClaimTurn = turn;
      } else if (text === followupText(scenario) && agent?.id === state.agentId) {
        state.newClaimTurn = turn;
        state.newClaimCount++;
      }
      save();
    });
    ctx.on('session/event', (session, event) => {
      if (session?.id !== state.agentId || event?.type !== 'turn/end') return;
      state.turnEnds.push({ turn: event.data?.turn ?? null, kind: event.data?.reason?.kind ?? null,
        cause: event.data?.reason?.reason?.kind ?? null });
      save();
    });
    ctx.on('tools/result', (exec, result) => {
      if (exec?.agent?.id !== state.agentId || !calls[scenario].includes(exec.callId)) return;
      state.resultOrder.push(exec.callId);
      state.results.push({ callId: exec.callId, isError: result?.isError === true,
        code: result?.error?.info?.code ?? null });
      if (scenario === 'parallel' && state.steerCount === 0
        && state.results.filter(item => calls.parallel.slice(0, 2).includes(item.callId)).length === 2) {
        state.steerCount++;
        exec.agent.steer(createUserMessage({ content: [{ type: 'text', text: followupText(scenario) }],
          source: { kind: 'user' } }));
      }
      save();
    });

    class SyntheticAdapter extends LlmAdapter {
      async *stream(options) {
        state.requests++;
        options.signal?.throwIfAborted();
        if (options.provider !== PROVIDER || options.model !== MODEL || state.requests > 3) {
          throw new Error('Unexpected synthetic model request');
        }
        state.modelSessionId ??= options.sessionId ?? null;
        state.toolCount = Array.isArray(options.tools) ? options.tools.length : -1;
        if (options.sessionId !== state.modelSessionId || state.toolCount !== 1
          || options.tools[0]?.name !== LIFECYCLE_TOOL) throw new Error('Synthetic tool scope mismatch');
        if (state.requests === 1) {
          const count = scenario === 'parallel' ? 2 : 1;
          for (let index = 0; index < count; index++) yield { type: 'tool-call-delta', index,
            id: calls[scenario][index], name: LIFECYCLE_TOOL,
            argumentsDelta: JSON.stringify({ key: keys[scenario][index] }) };
        } else if (state.requests === 2) {
          state.newMessageInRequest = options.messages?.some(message => message.source?.kind === 'user'
            && message.content?.some(block => block.type === 'text' && block.text === followupText(scenario))) === true;
          state.oldResultsInRequest = scenario === 'parallel'
            ? messageHas(options, calls.parallel[0], false) && messageHas(options, calls.parallel[1], true)
            : messageHas(options, calls.cancel[0], true);
          yield { type: 'tool-call-delta', index: 0, id: calls[scenario].at(-1),
            name: LIFECYCLE_TOOL, argumentsDelta: JSON.stringify({ key: 'new' }) };
        } else {
          state.newResultInRequest = messageHas(options, calls[scenario].at(-1), false);
          if (!state.newResultInRequest) throw new Error('Synthetic new tool result missing');
          yield { type: 'text-delta', index: 0, text: expected.marker };
        }
        save();
        yield { type: 'finish', reason: { kind: 'stop' } };
      }
    }
    ctx.llm.registerAdapter([PROVIDER], new SyntheticAdapter());
    ctx.tools.register(defineTool({
      name: LIFECYCLE_TOOL, description: 'Read fixed in-memory synthetic values only',
      parameters: { key: { type: 'string', required: true } },
      output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
      isConcurrencySafe: () => true,
      async execute(args, exec) {
        const key = args.key;
        if (!keys[scenario].includes(key) || exec?.agent?.id !== state.agentId
          || exec.agent.session?.id !== state.modelSessionId) {
          state.toolAgentConsistent = false;
          save();
          throw new Error('Synthetic execution scope mismatch');
        }
        state.bodyCalls[key] = (state.bodyCalls[key] ?? 0) + 1;
        state.activeBodies++;
        state.maxActiveBodies = Math.max(state.maxActiveBodies, state.activeBodies);
        if (state.activeBodies === 2) bothEntered.resolve();
        if (scenario === 'cancel' && key === 'cancel-old') {
          state.cancelBodyStarted = true;
          cancelEntered.resolve(exec);
          await releaseCancel.promise;
          state.cancelBodyReturnedSuccess = true;
          state.bodySettlementOrder.push(key);
          state.activeBodies--;
          save();
          return 'synthetic-cancel-body-success';
        }
        if (scenario === 'parallel' && key === 'old-a') await releaseA.promise;
        if (scenario === 'parallel' && key === 'old-b') {
          await bothEntered.promise;
          state.bodySettlementOrder.push(key);
          state.activeBodies--;
          save();
          releaseA.resolve();
          throw new Error('Synthetic fixed tool failure');
        }
        state.bodySettlementOrder.push(key);
        state.activeBodies--;
        save();
        return `synthetic-${key}-ok`;
      },
    }));
    ctx.provide('reflexmeshSyntheticFixtureReady', true);
  },
};

export default plugin;

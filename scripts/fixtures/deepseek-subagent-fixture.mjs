import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { intentDigest } from '../../adapters/task-evidence.mjs';

export const READ_TOOL = 'reflexmesh_subagent_read';
export const DELEGATE_TOOL = 'reflexmesh_spawn_children';
export const SHARED_CALL_ID = 'same-call-id';
export const PARENT_SUMMARY = 'Parent fixed memory read';
export const CHILD_SUMMARY = 'Child declared fixed memory read';
export const PARENT_TASK = `ReflexMesh-Intent: ${PARENT_SUMMARY}\nSynthetic parent-only task.`;
export const PLAIN_CHILD_TASK = 'Synthetic child task without explicit ReflexMesh marker.';
export const DECLARED_CHILD_TASK = `ReflexMesh-Intent: ${CHILD_SUMMARY}\nSynthetic child-only task.`;
export const FINAL_MARKER = 'REFLEXMESH_SYNTHETIC_SUBAGENT_OK';
const PROVIDER = 'reflexmesh-synthetic';
const MODEL = 'fixture-v1';
const hasToolResult = (options, callId) => options.messages?.some(message => message.content?.some(block =>
  block.type === 'tool-result' && block.toolCallId === callId && block.isError === false)) === true;

const plugin = {
  name: 'reflexmesh-subagent-fixture',
  inject: ['llm', 'tools', 'agents', 'subagents', 'reflexmeshObserverReady'],
  async apply(ctx, config) {
    if (!config || typeof config.packageRoot !== 'string' || typeof config.telemetryPath !== 'string'
      || typeof config.homePath !== 'string' || typeof config.cwdPath !== 'string') {
      throw new TypeError('Synthetic subagent fixture paths required');
    }
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
    const [{ LlmAdapter }, { defineTool }] = await Promise.all([
      import(pathToFileURL(join(sibling('dsh-llm'), 'lib', 'index.js')).href),
      import(pathToFileURL(join(sibling('dsh-tools'), 'lib', 'index.js')).href),
    ]);
    const state = { profileLoaded, observerLoaded, naturalBeforeExit: false,
      observerDrainedAtExit: false, kernelClosedAtExit: false, providerSpawnAvailable: false,
      parentId: null, childIds: [], parentClaims: 0, childClaims: [],
      parentRequests: 0, childRequests: {}, bodyCalls: [], results: [],
      subagentStarts: [], subagentEnds: [], childOwnership: [], childGone: [],
      childStops: [], modelToolCountValid: true, modelResultsValid: true,
    };
    const save = () => writeFileSync(config.telemetryPath, JSON.stringify(state), 'utf8');
    save();
    process.once('beforeExit', () => { state.naturalBeforeExit = true; try { save(); } catch {} });
    process.once('exit', () => {
      state.observerDrainedAtExit = observerReady?.observerDrained === true;
      state.kernelClosedAtExit = observerReady?.kernelClosed === true;
      try { save(); } catch {}
    });
    state.providerSpawnAvailable = ctx.subagents.getProvider('spawn')?.inheritsParentContext === false;
    ctx.on('agent/inbox/claimed', ({ agent, message } = {}) => {
      if (message?.source?.kind !== 'user' || message.role !== 'user') return;
      const text = message.content?.[0]?.type === 'text' ? message.content[0].text : null;
      if (text === PARENT_TASK) {
        state.parentClaims++;
        state.parentId = agent?.id ?? null;
      } else if (text === PLAIN_CHILD_TASK || text === DECLARED_CHILD_TASK) {
        state.childClaims.push({ id: agent?.id ?? null, declared: text === DECLARED_CHILD_TASK });
      }
      save();
    });
    ctx.on('subagent/start', info => {
      if (!info || info.provider !== 'spawn') return;
      state.subagentStarts.push({ id: info.id, runId: info.runId, local: info.local });
      save();
    });
    ctx.on('subagent/end', info => {
      if (!info || info.provider !== 'spawn') return;
      state.subagentEnds.push({ id: info.id, runId: info.runId, stopReason: info.stopReason });
      save();
    });
    ctx.on('tools/result', (exec, result) => {
      if (![READ_TOOL, DELEGATE_TOOL].includes(exec?.name)) return;
      state.results.push({ agentId: exec.agent?.id ?? null, callId: exec.callId,
        name: exec.name, isError: result?.isError === true, evidenceDigest: intentDigest(result) });
      save();
    });
    class SyntheticAdapter extends LlmAdapter {
      async *stream(options) {
        options.signal?.throwIfAborted();
        if (options.provider !== PROVIDER || options.model !== MODEL) throw new Error('Synthetic route mismatch');
        const agent = ctx.agents.get(options.sessionId);
        if (!agent || agent.session?.id !== options.sessionId) throw new Error('Synthetic live Agent required');
        const isParent = agent.session.header.origin !== 'subagent';
        if (isParent) {
          state.parentId ??= agent.id;
          state.parentRequests++;
          const request = state.parentRequests;
          if (request > 3) throw new Error('Too many synthetic parent requests');
          state.modelToolCountValid &&= Array.isArray(options.tools)
            && options.tools.map(tool => tool.name).sort().join('|') === [READ_TOOL, DELEGATE_TOOL].sort().join('|');
          if (request === 1) {
            yield { type: 'tool-call-delta', index: 0, id: SHARED_CALL_ID,
              name: READ_TOOL, argumentsDelta: JSON.stringify({ key: 'shared' }) };
            yield { type: 'tool-call-delta', index: 1, id: 'delegate-call',
              name: DELEGATE_TOOL, argumentsDelta: JSON.stringify({ kind: 'two-fresh-children' }) };
          } else if (request === 2) {
            state.modelResultsValid &&= hasToolResult(options, SHARED_CALL_ID)
              && hasToolResult(options, 'delegate-call');
            yield { type: 'tool-call-delta', index: 0, id: 'parent-after',
              name: READ_TOOL, argumentsDelta: JSON.stringify({ key: 'parent-after' }) };
          } else {
            state.modelResultsValid &&= hasToolResult(options, 'parent-after');
            yield { type: 'text-delta', index: 0, text: FINAL_MARKER };
          }
        } else {
          const first = options.messages?.find(message => message.source?.kind === 'user'
            && message.content?.[0]?.type === 'text');
          const text = first?.content[0].text;
          const kind = text === PLAIN_CHILD_TASK ? 'plain' : text === DECLARED_CHILD_TASK ? 'declared' : null;
          if (!kind) throw new Error('Unexpected synthetic child prompt');
          const request = (state.childRequests[agent.id] ?? 0) + 1;
          state.childRequests[agent.id] = request;
          if (request > 2) throw new Error('Too many synthetic child requests');
          state.modelToolCountValid &&= Array.isArray(options.tools)
            && options.tools.map(tool => tool.name).sort().join('|') === [READ_TOOL, DELEGATE_TOOL].sort().join('|');
          if (request === 1) yield { type: 'tool-call-delta', index: 0, id: SHARED_CALL_ID,
            name: READ_TOOL, argumentsDelta: JSON.stringify({ key: kind === 'plain' ? 'shared' : 'child-declared' }) };
          else {
            state.modelResultsValid &&= hasToolResult(options, SHARED_CALL_ID);
            yield { type: 'text-delta', index: 0, text: `SYNTHETIC_${kind.toUpperCase()}_DONE` };
          }
        }
        save();
        yield { type: 'finish', reason: { kind: 'stop' } };
      }
    }
    ctx.llm.registerAdapter([PROVIDER], new SyntheticAdapter());
    ctx.tools.register(defineTool({
      name: READ_TOOL, description: 'Read one fixed in-memory synthetic value',
      parameters: { key: { type: 'string', required: true } },
      output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
      async execute(args, exec) {
        if (!['shared', 'child-declared', 'parent-after'].includes(args.key)) throw new Error('Unknown synthetic key');
        state.bodyCalls.push({ agentId: exec.agent?.id ?? null, callId: exec.callId, name: READ_TOOL, key: args.key });
        save();
        const stage = args.key === 'shared' ? exec.agent.session.header.origin === 'subagent'
          ? 'plain-child-shared' : 'parent-shared' : args.key === 'child-declared'
          ? 'declared-child' : 'parent-after';
        return `synthetic-${stage}-ok`;
      },
    }));
    ctx.tools.register(defineTool({
      name: DELEGATE_TOOL, description: 'Start two fixed in-process synthetic children',
      parameters: { kind: { type: 'string', required: true } },
      output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
      async execute(args, exec) {
        if (args.kind !== 'two-fresh-children' || exec.agent?.id !== state.parentId) {
          throw new Error('Invalid synthetic parent delegation');
        }
        state.bodyCalls.push({ agentId: exec.agent.id, callId: exec.callId, name: DELEGATE_TOOL, key: args.kind });
        for (const [index, prompt] of [PLAIN_CHILD_TASK, DECLARED_CHILD_TASK].entries()) {
          const run = await ctx.subagents.start('spawn', { parent: exec.agent,
            prompt: [{ type: 'text', text: prompt }], signal: exec.signal });
          const child = run.localAgent;
          state.childIds.push(run.id);
          state.childOwnership.push(Boolean(child && child.id === run.id
            && child.session?.id === run.id && child.session.header.origin === 'subagent'
            && child.session.header.parentSession === exec.agent.session.id
            && ctx.agents.get(run.id) === child
            && ctx.agents.isOwnedBy(run.id, exec.agent)));
          try {
            const outcome = await run.result;
            state.childStops.push(outcome.stopReason);
          } finally {
            await run.dispose();
            state.childGone.push(ctx.agents.get(run.id) === undefined);
          }
          if (state.childStops[index] !== 'completed') throw new Error('Synthetic child did not complete');
          save();
        }
        return 'synthetic-delegations-ok';
      },
    }));
    ctx.provide('reflexmeshSyntheticFixtureReady', true);
  },
};

export default plugin;

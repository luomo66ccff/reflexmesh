import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const TASK = 'ReflexMesh-Intent: Verify isolated synthetic agent tool result\nUse only the fixed fixture tool.';
const MARKER = 'REFLEXMESH_SYNTHETIC_AGENT_OK';

// Private, one-shot startup receipt. No profile content, token or model output is serialized.
export default {
  name: 'reflexmesh-selected-profile-boot-fixture',
  inject: ['appReady', 'appExit', 'reflexmeshObserverReady',
    'reflexmeshSyntheticFixtureReady', 'agents', 'sessions'],
  apply(ctx, config) {
    if (!config || typeof config.telemetryPath !== 'string'
      || typeof config.homePath !== 'string' || typeof config.profile !== 'string'
      || typeof config.observerOverlayPath !== 'string' || typeof config.fixtureOverlayPath !== 'string'
      || typeof config.packageRoot !== 'string')
      throw new TypeError('Selected-profile boot fixture paths required');
    const observer = ctx.get('reflexmeshObserverReady');
    const ready = ctx.get('appReady');
    const exit = ctx.get('appExit');
    if (!observer || !ctx.get('reflexmeshSyntheticFixtureReady')
      || !ctx.get('agents') || !ctx.get('sessions')
      || typeof ready?.onReady !== 'function' || typeof exit !== 'function')
      throw new Error('Selected-profile boot services unavailable');
    const state = { startupCommitted: false, observerEntryActivated: false,
      overlayArgPresent: false, profileTreeBound: false, webServerReady: false,
      naturalBeforeExit: false, observerDrainedAtExit: false, kernelClosedAtExit: false,
      agentTurnCompleted: false, finalFixtureMarker: false, phase: 'waiting_ready' };
    const save = () => writeFileSync(config.telemetryPath, JSON.stringify(state), 'utf8');
    save();
    process.once('beforeExit', () => { state.naturalBeforeExit = true; try { save(); } catch {} });
    process.once('exit', () => {
      state.observerDrainedAtExit = observer.observerDrained === true;
      state.kernelClosedAtExit = observer.kernelClosed === true;
      try { save(); } catch {}
    });
    ready.onReady(() => { void (async () => {
      const profileFile = join(config.homePath, 'profiles', config.profile, 'cordis.yml');
      const expectedUrl = new URL('../../adapters/deepseek-loader-plugin.mjs', import.meta.url).href;
      const entry = [...(ctx.get('loader')?.entries() ?? [])]
        .find(item => item.options?.id === 'reflexmesh-observer');
      const patchArgs = [];
      for (let i = 0; i < process.argv.length - 1; i++)
        if (process.argv[i] === '--patch') patchArgs.push(process.argv[i + 1]);
      state.startupCommitted = true;
      state.observerEntryActivated = entry?.options?.name === expectedUrl && entry.fiber?.state === 2;
      state.profileTreeBound = entry?.parent?.tree?.filename === profileFile;
      state.overlayArgPresent = patchArgs.length === 2
        && patchArgs[0] === config.observerOverlayPath && patchArgs[1] === config.fixtureOverlayPath;
      const server = ctx.get('webServer');
      state.webServerReady = server?.host === '127.0.0.1'
        && Number.isSafeInteger(server.port) && server.port > 0 && server.port <= 65535;
      state.phase = 'importing_api';
      save();
      const sibling = name => join(config.packageRoot, '..', name);
      const [{ createUserMessage }, { installModelSelection }] = await Promise.all([
        import(pathToFileURL(join(sibling('dsh-llm'), 'lib', 'index.js')).href),
        import(pathToFileURL(join(sibling('dsh-agent'), 'lib', 'index.js')).href),
      ]);
      state.phase = 'creating_agent'; save();
      const selection = { provider: 'reflexmesh-synthetic', model: 'fixture-v1' };
      const { agent } = await ctx.get('agents').create({
        sessionId: `session-${randomUUID()}`, meta: { cwd: process.cwd() },
        agentOptions: selection,
        setup: agentCtx => {
          installModelSelection(agentCtx, { current: selection, assembled: undefined });
        },
      });
      state.phase = 'running_agent'; save();
      await agent.whenIdle();
      const firstSeq = agent.session.seq;
      agent.followup(createUserMessage({ content: [{ type: 'text', text: TASK }], source: { kind: 'user' } }));
      await agent.whenIdle();
      state.phase = 'reading_outcome'; save();
      await ctx.get('sessions').flush(agent.session);
      const events = [];
      for (let seq = firstSeq; seq < agent.session.seq; seq++) events.push(agent.session.eventAt(seq));
      state.agentTurnCompleted = events.some(event => event?.type === 'turn/end'
        && event.data?.reason?.kind === 'completed');
      state.finalFixtureMarker = events.some(event => event?.type === 'assistant/message'
        && event.data?.message?.content?.some(block => block.type === 'text' && block.text === MARKER));
      state.phase = 'complete';
      save();
      exit(state.agentTurnCompleted && state.finalFixtureMarker ? 0 : 1);
    })().catch(() => {
      try { save(); } catch {} exit(1);
    }); });
  },
};

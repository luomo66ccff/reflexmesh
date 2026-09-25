import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const WEB_UI_TASK = 'ReflexMesh-Intent: Verify isolated synthetic agent tool result\nUse only the fixed fixture tool.';
export const WEB_UI_MARKER = 'REFLEXMESH_SYNTHETIC_AGENT_OK';

// The fixture deliberately does not create an Agent or submit a message.
// A real browser must use the installed Web UI before the parent sends finish.
export default {
  name: 'reflexmesh-web-ui-fixture',
  inject: ['appReady', 'appExit', 'connection', 'webServer', 'sessions',
    'reflexmeshObserverReady', 'reflexmeshSyntheticFixtureReady'],
  apply(ctx, config) {
    if (!config || typeof config.statusPath !== 'string'
      || typeof config.urlPath !== 'string'
      || typeof config.syntheticTelemetryPath !== 'string'
      || typeof config.homePath !== 'string'
      || typeof config.profile !== 'string'
      || typeof config.observerOverlayPath !== 'string'
      || typeof config.fixtureOverlayPath !== 'string'
      || typeof process.send !== 'function')
      throw new TypeError('Web UI fixture requires supervised private paths');
    const ready = ctx.get('appReady');
    const exit = ctx.get('appExit');
    const observer = ctx.get('reflexmeshObserverReady');
    const sessions = ctx.get('sessions');
    const finish = code => {
      if (process.connected) process.disconnect();
      exit(code);
    };
    if (!ready || typeof ready.onReady !== 'function' || typeof exit !== 'function'
      || !observer || !sessions || !ctx.get('reflexmeshSyntheticFixtureReady'))
      throw new Error('Web UI fixture services unavailable');
    const state = { startupCommitted: false, observerEntryActivated: false,
      overlayArgPresent: false, profileTreeBound: false, webServerReady: false,
      webUserMessageSeen: false, agentTurnCompleted: false,
      finalFixtureMarker: false, naturalBeforeExit: false,
      observerDrainedAtExit: false, kernelClosedAtExit: false,
      phase: 'waiting_ready' };
    const save = () => writeFileSync(config.statusPath, JSON.stringify(state), { mode: 0o600 });
    save();
    process.once('beforeExit', () => { state.naturalBeforeExit = true; try { save(); } catch {} });
    process.once('exit', () => {
      state.observerDrainedAtExit = observer.observerDrained === true;
      state.kernelClosedAtExit = observer.kernelClosed === true;
      try { save(); } catch {}
    });
    ready.onReady(() => {
      try {
        const server = ctx.get('webServer');
        const connection = ctx.get('connection');
        const profileFile = join(config.homePath, 'profiles', config.profile, 'cordis.yml');
        const expectedUrl = new URL('../../adapters/deepseek-loader-plugin.mjs', import.meta.url).href;
        const entry = [...(ctx.get('loader')?.entries() ?? [])]
          .find(item => item.options?.id === 'reflexmesh-observer');
        const patches = [];
        for (let i = 0; i < process.argv.length - 1; i++)
          if (process.argv[i] === '--patch') patches.push(process.argv[i + 1]);
        state.observerEntryActivated = entry?.options?.name === expectedUrl && entry.fiber?.state === 2;
        state.profileTreeBound = entry?.parent?.tree?.filename === profileFile;
        state.overlayArgPresent = patches.length === 2
          && patches[0] === config.observerOverlayPath
          && patches[1] === config.fixtureOverlayPath;
        state.webServerReady = server?.host === '127.0.0.1'
          && Number.isSafeInteger(server.port) && server.port > 0 && server.port <= 65535;
        if (!state.observerEntryActivated || !state.profileTreeBound
          || !state.overlayArgPresent || !state.webServerReady
          || typeof connection?.authenticatedUrl !== 'function')
          throw new Error('Web UI fixture startup mismatch');
        const url = connection.authenticatedUrl(`http://127.0.0.1:${server.port}`);
        writeFileSync(config.urlPath, url, { flag: 'wx', mode: 0o600 });
        state.startupCommitted = true;
        state.phase = 'ready_for_browser';
        save();
      } catch {
        state.phase = 'startup_failed';
        try { save(); } catch {}
        finish(1);
      }
    });
    process.on('message', message => {
      if (message?.type !== 'reflexmesh-web-ui-finish') return;
      void (async () => {
        state.phase = 'checking_session'; save();
        const synthetic = JSON.parse(readFileSync(config.syntheticTelemetryPath, 'utf8'));
        const session = typeof synthetic.modelSessionId === 'string'
          ? sessions.get(synthetic.modelSessionId) : null;
        if (!session) throw new Error('Web UI fixture session unavailable');
        await sessions.flush(session);
        const events = [];
        for (let seq = 0; seq < session.seq; seq++) events.push(session.eventAt(seq));
        state.webUserMessageSeen = events.some(event => event?.type === 'user/message'
          && event.data?.source?.kind === 'user'
          && event.data?.content?.some(block => block.type === 'text'
            && block.text === WEB_UI_TASK));
        state.agentTurnCompleted = events.some(event => event?.type === 'turn/end'
          && event.data?.reason?.kind === 'completed');
        state.finalFixtureMarker = events.some(event => event?.type === 'assistant/message'
          && event.data?.message?.content?.some(block => block.type === 'text'
            && block.text === WEB_UI_MARKER));
        state.phase = 'complete'; save();
        finish(state.webUserMessageSeen && state.agentTurnCompleted
          && state.finalFixtureMarker ? 0 : 1);
      })().catch(() => {
        state.phase = 'session_check_failed';
        try { save(); } catch {}
        finish(1);
      });
    });
  },
};

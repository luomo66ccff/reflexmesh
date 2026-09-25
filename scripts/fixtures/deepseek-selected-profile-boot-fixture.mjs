import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

// Private, one-shot startup receipt. No profile content, token or model output is serialized.
export default {
  name: 'reflexmesh-selected-profile-boot-fixture',
  inject: ['appReady', 'appExit', 'reflexmeshObserverReady'],
  apply(ctx, config) {
    if (!config || typeof config.telemetryPath !== 'string'
      || typeof config.homePath !== 'string' || typeof config.profile !== 'string'
      || typeof config.observerOverlayPath !== 'string' || typeof config.fixtureOverlayPath !== 'string')
      throw new TypeError('Selected-profile boot fixture paths required');
    const observer = ctx.get('reflexmeshObserverReady');
    const ready = ctx.get('appReady');
    const exit = ctx.get('appExit');
    if (!observer || typeof ready?.onReady !== 'function' || typeof exit !== 'function')
      throw new Error('Selected-profile boot services unavailable');
    const state = { startupCommitted: false, observerEntryActivated: false,
      overlayArgPresent: false, profileTreeBound: false, webServerReady: false,
      naturalBeforeExit: false, observerDrainedAtExit: false, kernelClosedAtExit: false };
    const save = () => writeFileSync(config.telemetryPath, JSON.stringify(state), 'utf8');
    save();
    process.once('beforeExit', () => { state.naturalBeforeExit = true; try { save(); } catch {} });
    process.once('exit', () => {
      state.observerDrainedAtExit = observer.observerDrained === true;
      state.kernelClosedAtExit = observer.kernelClosed === true;
      try { save(); } catch {}
    });
    ready.onReady(() => {
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
      save();
      exit(0);
    });
  },
};

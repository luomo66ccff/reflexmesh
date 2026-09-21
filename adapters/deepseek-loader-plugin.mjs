import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { toolPreflightPack } from '../dist/index.js';
import { SqliteKernel } from './sqlite-kernel.mjs';
import { assertSqliteWalRuntime } from './sqlite-runtime.mjs';
import { TaskAwareBoundary } from './task-boundary.mjs';
import { installDeepSeekObserver } from './deepseek-plugin.mjs';
import { createDeepSeekTaskSource } from './deepseek-task-source.mjs';
import { validateDeepSeekLoaderConfig } from './deepseek-loader-config.mjs';
import { ABSTAIN_CAPABILITIES } from './provider-binding.mjs';

export { validateDeepSeekLoaderConfig } from './deepseek-loader-config.mjs';

/** Product loader entrypoint. It observes the host; it never authorizes or executes its tools. */
const plugin = {
  name: 'reflexmesh-deepseek',
  inject: ['agents', 'sessions', 'tools'],
  async apply(ctx, config) {
    const options = validateDeepSeekLoaderConfig(config);
    assertSqliteWalRuntime();
    mkdirSync(dirname(options.dbPath), { recursive: true, mode: 0o700 });
    const kernel = new SqliteKernel(options.dbPath);
    let taskSource, observer;
    let observerDrained = false, kernelClosed = false;
    try {
      taskSource = createDeepSeekTaskSource(ctx, { intentMode: options.intentMode });
      const provider = { id: 'abstain', capabilities: ABSTAIN_CAPABILITIES,
        evaluate: async () => { throw new Error('Decision provider not configured'); } };
      const boundary = new TaskAwareBoundary({ kernel, provider, pack: toolPreflightPack,
        tenantId: options.tenantId, scope: options.scope,
        binding: { providerId: 'abstain', modelId: 'not-configured', revision: 'abstain-v1',
          calibrationRef: null, authorizationRevision: 'host-owned-shadow', toolsetRevision: 'host-owned-shadow' },
      });
      observer = installDeepSeekObserver(ctx, { boundary, identity: taskSource.identity,
        resolveIntent: taskSource.resolveIntent, onError: () => ctx.logger?.warn?.('reflexmesh_shadow_observation_failed') });
      ctx.provide('reflexmeshObserverReady', {
        get observerDrained() { return observerDrained; },
        get kernelClosed() { return kernelClosed; },
      });
    } catch (error) {
      taskSource?.dispose();
      try { await observer?.dispose(); } catch {}
      kernel.close();
      throw error;
    }
    let disposal;
    return () => disposal ??= (async () => {
      taskSource.dispose();
      await observer.dispose();
      observerDrained = true;
      kernel.close();
      kernelClosed = true;
    })();
  },
};

export default plugin;

import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { toolPreflightPack } from '../dist/index.js';
import { SqliteKernel } from './sqlite-kernel.mjs';
import { assertSqliteWalRuntime } from './sqlite-runtime.mjs';
import { TaskAwareBoundary } from './task-boundary.mjs';
import { installDeepSeekObserver } from './deepseek-plugin.mjs';
import { createDeepSeekTaskSource } from './deepseek-task-source.mjs';
import { validateDeepSeekLoaderConfig } from './deepseek-loader-config.mjs';
import { createDeepSeekStorageFence } from './deepseek-storage-fence.mjs';
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
    let storageFence, taskSource, observer;
    let observerDrained = false, kernelClosed = false;
    try {
      storageFence = createDeepSeekStorageFence(kernel);
      taskSource = createDeepSeekTaskSource(ctx, { intentMode: options.intentMode });
      const provider = { id: 'abstain', capabilities: ABSTAIN_CAPABILITIES,
        evaluate: async () => { throw new Error('Decision provider not configured'); } };
      const boundary = new TaskAwareBoundary({ kernel: storageFence.kernel, provider, pack: toolPreflightPack,
        tenantId: options.tenantId, scope: options.scope,
        binding: { providerId: 'abstain', modelId: 'not-configured', revision: 'abstain-v1',
          calibrationRef: null, authorizationRevision: 'host-owned-shadow', toolsetRevision: 'host-owned-shadow' },
      });
      observer = installDeepSeekObserver(ctx, { boundary, identity: taskSource.identity,
        resolveIntent: taskSource.resolveIntent, shutdownResultWaitMs: options.shutdownResultWaitMs,
        shutdownDrainWaitMs: options.shutdownDrainWaitMs, storageFence,
        onError: code => ctx.logger?.warn?.(code) });
      ctx.provide('reflexmeshObserverReady', {
        get observerDrained() { return observerDrained; },
        get kernelClosed() { return kernelClosed; },
        // True only when the optional drain deadline detached callbacks, not
        // for the ordinary protective revoke immediately before kernel close.
        get storageRevoked() { return observer.drainStatus().storageRevoked; },
        // These read through the observer while disposal is pending; a hung
        // admission/result write must not make the visible count stale.
        get shutdownMissingResults() { return observer.drainStatus().missingResults; },
        get shutdownDrain() { return observer.drainStatus(); },
      });
    } catch (error) {
      taskSource?.dispose();
      try { await observer?.dispose(); } catch {}
      storageFence?.revoke();
      kernel.close();
      throw error;
    }
    let disposal;
    return () => disposal ??= (async () => {
      taskSource.dispose();
      const receipt = await observer.dispose();
      observerDrained = receipt.detachedBefore === 0 && receipt.detachedAfter === 0;
      storageFence.revoke();
      kernel.close();
      kernelClosed = true;
    })();
  },
};

export default plugin;

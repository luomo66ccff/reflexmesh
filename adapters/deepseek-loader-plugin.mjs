import { mkdirSync } from 'node:fs';
import { dirname, isAbsolute } from 'node:path';
import { toolPreflightPack } from '../dist/index.js';
import { SqliteKernel } from './sqlite-kernel.mjs';
import { TaskAwareBoundary } from './task-boundary.mjs';
import { installDeepSeekObserver } from './deepseek-plugin.mjs';
import { createDeepSeekTaskSource } from './deepseek-task-source.mjs';

const CONFIG_KEYS = new Set(['dbPath', 'tenantId', 'scope', 'intentMode']);
const safeName = value => typeof value === 'string' && value.length > 0 && value.length <= 64
  && !/[\u0000-\u001f\u007f]/.test(value);

/** No implicit home path, provider env, credential, or remote-model fallback. */
export function validateDeepSeekLoaderConfig(config) {
  if (!config || typeof config !== 'object' || Array.isArray(config)
    || Object.keys(config).some(key => !CONFIG_KEYS.has(key))) throw new TypeError('Invalid DeepSeek loader configuration');
  const { dbPath, tenantId, scope, intentMode = 'off' } = config;
  if (typeof dbPath !== 'string' || !isAbsolute(dbPath) || /[\u0000-\u001f\u007f]/.test(dbPath)
    || !safeName(tenantId) || !safeName(scope) || !['off', 'explicit-summary'].includes(intentMode)) {
    throw new TypeError('Explicit DeepSeek database, tenant, scope, and intent mode required');
  }
  return { dbPath, tenantId, scope, intentMode };
}

/** Product loader entrypoint. It observes the host; it never authorizes or executes its tools. */
const plugin = {
  name: 'reflexmesh-deepseek',
  inject: ['agents', 'sessions', 'tools'],
  async apply(ctx, config) {
    const options = validateDeepSeekLoaderConfig(config);
    mkdirSync(dirname(options.dbPath), { recursive: true, mode: 0o700 });
    const kernel = new SqliteKernel(options.dbPath);
    let taskSource, observer;
    let observerDrained = false, kernelClosed = false;
    try {
      taskSource = createDeepSeekTaskSource(ctx, { intentMode: options.intentMode });
      const provider = { id: 'abstain', evaluate: async () => { throw new Error('Decision provider not configured'); } };
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

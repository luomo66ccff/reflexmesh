import { isAbsolute } from 'node:path';

const CONFIG_KEYS = new Set(['dbPath', 'tenantId', 'scope', 'intentMode',
  'shutdownResultWaitMs', 'shutdownDrainWaitMs']);
const unsafe = /[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/;
const safeName = value => typeof value === 'string' && value.length > 0 && value.length <= 64 && !unsafe.test(value);

/** Pure validation shared by the Loader entry and the read-only doctor. */
export function validateDeepSeekLoaderConfig(config) {
  if (!config || typeof config !== 'object' || Array.isArray(config)
    || Object.keys(config).some(key => !CONFIG_KEYS.has(key))) throw new TypeError('Invalid DeepSeek loader configuration');
  const { dbPath, tenantId, scope, intentMode = 'off', shutdownResultWaitMs,
    shutdownDrainWaitMs } = config;
  if (typeof dbPath !== 'string' || dbPath.length > 1024 || !isAbsolute(dbPath) || unsafe.test(dbPath)
    || !safeName(tenantId) || !safeName(scope) || !['off', 'explicit-summary'].includes(intentMode)
    || (shutdownResultWaitMs !== undefined && (!Number.isSafeInteger(shutdownResultWaitMs)
      || shutdownResultWaitMs < 0 || shutdownResultWaitMs > 60_000))
    || (shutdownDrainWaitMs !== undefined && (!Number.isSafeInteger(shutdownDrainWaitMs)
      || shutdownDrainWaitMs < 0 || shutdownDrainWaitMs > 60_000))) {
    throw new TypeError('Explicit DeepSeek database, tenant, scope, and intent mode required');
  }
  return { dbPath, tenantId, scope, intentMode,
    ...(shutdownResultWaitMs === undefined ? {} : { shutdownResultWaitMs }),
    ...(shutdownDrainWaitMs === undefined ? {} : { shutdownDrainWaitMs }) };
}

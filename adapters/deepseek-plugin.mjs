import { fromDeepSeekCall } from '../dist/index.js';
import { resolveHostIntent } from './task-evidence.mjs';

/** Source-verified Cordis seams; no dependency on or patching of the DeepSeek agent loop.
 * Target tools source blob: 6be7be61e257cd9e38c8a3122298316bf3df9892.
 * Caller owns identity resolution. This is SHADOW ONLY, not a monotonic security guard.
 */
export function installDeepSeekObserver(ctx, { boundary, identity, resolveIntent, onError = () => {} }) {
  if (typeof ctx?.on !== 'function' || typeof identity !== 'function' || (resolveIntent !== undefined && typeof resolveIntent !== 'function')) throw new TypeError('Context and identity resolver required');
  const pending = new Set();
  const maxPending = 256;
  const warn = () => { try { onError('reflexmesh_shadow_observation_failed'); } catch {} };
  const offPre = ctx.on('tools/pre-execute', async (exec, next) => {
    try {
      if (!exec.signal.aborted) {
        const intent = resolveHostIntent(resolveIntent, exec);
        if (!exec.signal.aborted) await boundary.before(fromDeepSeekCall(exec, identity(exec)), intent);
      }
    } catch { warn(); }
    // Never return {kind:'allow'}: preserve the rest of the host permission waterfall.
    return next();
  });
  const offResult = ctx.on('tools/result', (exec, result) => {
    if (pending.size >= maxPending) { warn(); return undefined; }
    // tools/result is a synchronous observe-only event. Track async work without changing its return type.
    const task = Promise.resolve().then(() => boundary.after(fromDeepSeekCall(exec, identity(exec)),
      result.isError === true ? 'failed' : result.isError === false ? 'succeeded' : 'unknown', result, 'harness-reported')).catch(warn);
    pending.add(task); task.then(() => pending.delete(task));
    return undefined;
  });
  return {
    async flush() { await Promise.all([...pending]); },
    async dispose() { offPre(); offResult(); await Promise.all([...pending]); },
  };
}

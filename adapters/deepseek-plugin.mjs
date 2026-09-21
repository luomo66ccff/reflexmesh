import { createHash } from 'node:crypto';
import { canonical, fromDeepSeekCall } from '../dist/index.js';
import { resolveHostIntent } from './task-evidence.mjs';

const callDigest = call => createHash('sha256').update(canonical(call)).digest('hex');

/** Source-verified Cordis seams; no dependency on or patching of the DeepSeek agent loop.
 * Target tools source blob: 6be7be61e257cd9e38c8a3122298316bf3df9892.
 * Caller owns identity resolution. This is SHADOW ONLY, not a monotonic security guard.
 */
export function installDeepSeekObserver(ctx, { boundary, identity, resolveIntent, onError = () => {} }) {
  if (typeof ctx?.on !== 'function' || typeof identity !== 'function' || (resolveIntent !== undefined && typeof resolveIntent !== 'function')) throw new TypeError('Context and identity resolver required');
  // The host uses this same execution object at pre-execute and result. Keep
  // only accepted calls, bounded until their authoritative result is drained.
  const active = new Map();
  const maxActive = 256;
  let closing = false;
  const warn = () => { try { onError('reflexmesh_shadow_observation_failed'); } catch {} };
  const release = (exec, state) => {
    if (active.get(exec) === state) active.delete(exec);
    state.settle();
  };
  const observePre = async (exec, next) => {
    if (closing) return next();
    if (active.size >= maxActive || active.has(exec)) { warn(); return next(); }
    let settle;
    const done = new Promise(resolve => { settle = resolve; });
    const state = { done, settle, resultSeen: false, callDigest: null, agent: null, session: null };
    active.set(exec, state);
    try {
      if (!exec.signal.aborted) {
        const intent = resolveHostIntent(resolveIntent, exec);
        if (!exec.signal.aborted) {
          const call = fromDeepSeekCall(exec, identity(exec));
          const digest = callDigest(call);
          state.agent = exec.agent;
          state.session = exec.agent?.session;
          await boundary.before(call, intent);
          // Only a resolved admission can own a later outcome. A conflicting
          // call ID must not attach a new task's result to an older journal row.
          state.callDigest = digest;
        }
      }
    } catch { warn(); }
    finally {
      // No accepted observation remains to drain, including pre-dispatch aborts.
      if (state.callDigest === null) release(exec, state);
    }
    // Never return {kind:'allow'}: preserve the rest of the host permission waterfall.
    return next();
  };
  const observeResult = (exec, result) => {
    const state = active.get(exec);
    if (!state || state.resultSeen) return undefined;
    state.resultSeen = true;
    const settle = () => release(exec, state);
    let call, evidence, status;
    try {
      // Capture during the synchronous notification: later host listeners may
      // dispose the Agent or mutate their own execution/result objects. Still
      // validate current identity, never resurrect an invalid admission identity.
      call = fromDeepSeekCall(exec, identity(exec));
      if (state.callDigest === null || callDigest(call) !== state.callDigest
        || exec.agent !== state.agent || exec.agent?.session !== state.session) {
        throw new TypeError('Host result does not match its accepted call');
      }
      if (!result || typeof result !== 'object' || Array.isArray(result)) throw new TypeError('Invalid host result');
      const serialized = canonical(result);
      if (Buffer.byteLength(serialized) > 1_000_000) throw new TypeError('Outcome evidence too large');
      evidence = JSON.parse(serialized); // Private bounded copy, not a freeze/mutation of host data.
      // Installed dsh-tools uses ABORTED after body invocation, even if that
      // body returned success. Cancellation is not proof of absent effects.
      status = evidence.isError === true
        ? evidence.error?.info?.code === 'ABORTED' ? 'unknown' : 'failed'
        : evidence.isError === false ? 'succeeded' : 'unknown';
    } catch { warn(); settle(); return undefined; }
    // tools/result remains synchronous and observe-only; only journal work is deferred.
    const task = Promise.resolve().then(() => boundary.after(call, status, evidence, 'harness-reported'))
      .catch(warn).finally(settle);
    void task;
    return undefined;
  };
  let offPre, offResult, shutdownPromise;
  const flush = () => Promise.all([...active.values()].map(state => state.done));
  const shutdown = () => {
    if (shutdownPromise) return shutdownPromise;
    closing = true;
    offPre();
    shutdownPromise = (async () => {
      await flush();
      offResult();
    })();
    return shutdownPromise;
  };
  let stop;
  if (typeof ctx.effect === 'function') {
    // Cordis unloads independent ctx.on effects in parallel. Group their
    // disposers in one effect instead: its returned drain runs first, then
    // result and pre listeners are removed in reverse collection order.
    stop = ctx.effect(function* () {
      offPre = ctx.on('tools/pre-execute', observePre);
      yield offPre;
      offResult = ctx.on('tools/result', observeResult);
      yield offResult;
      return shutdown;
    }, 'reflexmesh.deepseek.observer');
  } else {
    offPre = ctx.on('tools/pre-execute', observePre);
    try { offResult = ctx.on('tools/result', observeResult); }
    catch (error) { offPre(); throw error; }
    stop = shutdown;
  }
  return {
    flush,
    async dispose() {
      const stopped = stop();
      await shutdown();
      await stopped;
    },
  };
}

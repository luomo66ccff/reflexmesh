import { createHash } from 'node:crypto';
import { canonical, fromDeepSeekCall } from '../dist/index.js';
import { resolveHostIntent } from './task-evidence.mjs';
import { isDeepSeekStorageFence } from './deepseek-storage-fence.mjs';

const callDigest = call => createHash('sha256').update(canonical(call)).digest('hex');
const ABANDONED = Symbol('deepseek-storage-abandoned');

/** Source-verified Cordis seams; no dependency on or patching of the DeepSeek agent loop.
 * Target tools source blob: 6be7be61e257cd9e38c8a3122298316bf3df9892.
 * Caller owns identity resolution. This is SHADOW ONLY, not a monotonic security guard.
 */
export function installDeepSeekObserver(ctx, { boundary, identity, resolveIntent, onError = () => {},
  shutdownResultWaitMs = 5000, shutdownDrainWaitMs, storageFence } = {}) {
  if (typeof ctx?.on !== 'function' || typeof identity !== 'function' || (resolveIntent !== undefined && typeof resolveIntent !== 'function')) throw new TypeError('Context and identity resolver required');
  if (!Number.isSafeInteger(shutdownResultWaitMs) || shutdownResultWaitMs < 0 || shutdownResultWaitMs > 60_000) throw new TypeError('Invalid DeepSeek shutdown result wait');
  if (shutdownDrainWaitMs !== undefined && (!Number.isSafeInteger(shutdownDrainWaitMs)
    || shutdownDrainWaitMs < 0 || shutdownDrainWaitMs > 60_000
    || !isDeepSeekStorageFence(storageFence, boundary))) {
    throw new TypeError('Invalid DeepSeek shutdown drain fence');
  }
  if (storageFence !== undefined && !isDeepSeekStorageFence(storageFence, boundary)) {
    throw new TypeError('Invalid DeepSeek storage fence');
  }
  // The host uses this same execution object at pre-execute and result. Keep
  // only accepted calls, bounded until their authoritative result is drained.
  const active = new Map();
  const maxActive = 256;
  let closing = false;
  let resultWindowClosed = false;
  let missingResults = 0;
  let missingWarningSent = false;
  let drainPendingWarningSent = false;
  let storageRevoked = false, detachedBefore = 0, detachedAfter = 0;
  const warn = () => { try { onError('reflexmesh_shadow_observation_failed'); } catch {} };
  const warnMissing = () => {
    if (missingResults > 0 && !missingWarningSent) {
      missingWarningSent = true;
      try { onError('reflexmesh_shadow_result_missing_on_shutdown'); } catch {}
    }
  };
  const drainStatus = () => {
    let pendingBefore = 0, pendingResults = 0, pendingAfter = 0;
    for (const state of active.values()) {
      if (state.phase === 'pre') pendingBefore++;
      else if (state.phase === 'waiting-result') pendingResults++;
      else if (state.phase === 'after') pendingAfter++;
    }
    return Object.freeze({ closing, resultWindowClosed, pendingBefore, pendingResults,
      pendingAfter, missingResults, ...(storageFence ? { storageRevoked, detachedBefore, detachedAfter } : {}) });
  };
  const warnDrainPending = () => {
    if (drainPendingWarningSent) return;
    const status = drainStatus();
    if (status.pendingBefore === 0 && status.pendingAfter === 0) return;
    drainPendingWarningSent = true;
    try { onError('reflexmesh_shadow_shutdown_drain_pending'); } catch {}
  };
  const release = (exec, state) => {
    if (state.phase === 'released') return;
    state.phase = 'released';
    if (active.get(exec) === state) active.delete(exec);
    state.settle();
  };
  const observePre = async (exec, next) => {
    if (closing) return next();
    if (active.size >= maxActive || active.has(exec)) { warn(); return next(); }
    let settle;
    const done = new Promise(resolve => { settle = resolve; });
    let abandon;
    const abandoned = storageFence ? new Promise(resolve => { abandon = () => resolve(ABANDONED); }) : null;
    const state = { done, settle, phase: 'pre', resultSeen: false, earlyResultRejected: false,
      callDigest: null, agent: null, session: null, abandoned, abandon };
    active.set(exec, state);
    try {
      if (!exec.signal.aborted) {
        const intent = resolveHostIntent(resolveIntent, exec);
        if (!exec.signal.aborted) {
          const call = fromDeepSeekCall(exec, identity(exec));
          const digest = callDigest(call);
          state.agent = exec.agent;
          state.session = exec.agent?.session;
          if (abandoned) await Promise.race([boundary.before(call, intent), abandoned]);
          else await boundary.before(call, intent);
          // Only a resolved admission can own a later outcome. A conflicting
          // call ID must not attach a new task's result to an older journal row.
          if (state.phase !== 'released') state.callDigest = digest;
        }
      }
    } catch { if (state.phase !== 'released') warn(); }
    finally {
      // A result that arrives before admission cannot release an in-flight
      // before() write or later attach a second result to that same call.
      if (state.phase !== 'released') {
        if (state.callDigest === null || state.earlyResultRejected) release(exec, state);
        else if (resultWindowClosed) {
          missingResults++;
          release(exec, state);
          warnMissing();
        } else state.phase = 'waiting-result';
      }
    }
    // Never return {kind:'allow'}: preserve the rest of the host permission waterfall.
    return next();
  };
  const observeResult = (exec, result) => {
    const state = active.get(exec);
    if (resultWindowClosed || !state || state.resultSeen) return undefined;
    state.resultSeen = true;
    if (state.phase === 'pre') {
      state.earlyResultRejected = true;
      warn();
      return undefined;
    }
    if (state.phase !== 'waiting-result') return undefined;
    state.phase = 'after'; // Includes the queued journal microtask.
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
      .catch(() => { if (state.phase !== 'released') warn(); }).finally(settle);
    void task;
    return undefined;
  };
  let offPre, offResult, shutdownPromise, resultListenerStopped = false;
  const flush = () => Promise.all([...active.values()].map(state => state.done));
  const stopResults = () => {
    if (resultListenerStopped) return;
    resultWindowClosed = true; // A saved listener callback must also fail closed.
    resultListenerStopped = true;
    offResult();
  };
  const expireResults = () => {
    stopResults();
    for (const [exec, state] of active) {
      if (state.phase !== 'waiting-result') continue;
      missingResults++;
      release(exec, state);
    }
    warnMissing();
    warnDrainPending();
  };
  const detachFencedStorage = () => {
    // Only the Loader-owned synchronous SQLite facade may be revoked. Its
    // methods cannot overlap this timer in the same event loop; every later
    // continuation is rejected before touching the raw kernel.
    storageFence.revoke();
    storageRevoked = true;
    for (const [exec, state] of active) {
      if (state.phase === 'pre') { detachedBefore++; state.abandon(); }
      else if (state.phase === 'after') detachedAfter++;
      release(exec, state);
    }
    try { onError('reflexmesh_shadow_shutdown_storage_revoked'); } catch {}
  };
  const shutdown = () => {
    if (shutdownPromise) return shutdownPromise;
    closing = true;
    // Publish the one shutdown promise before offPre/onError can synchronously
    // re-enter disposal, especially with a zero-length result window.
    let resolveShutdown, rejectShutdown;
    shutdownPromise = new Promise((resolve, reject) => {
      resolveShutdown = resolve;
      rejectShutdown = reject;
    });
    void (async () => {
      offPre();
      let timer;
      try {
        if (shutdownResultWaitMs === 0) expireResults();
        else await Promise.race([flush(), new Promise(resolve => {
          timer = setTimeout(() => { expireResults(); resolve(); }, shutdownResultWaitMs);
        })]);
        // A missing result may be abandoned. Generic callbacks still drain;
        // only the Loader's explicitly fenced SQLite boundary can be detached.
        if (shutdownDrainWaitMs === undefined) await flush();
        else {
          let drainTimer;
          try {
            const drained = await Promise.race([flush().then(() => true), new Promise(resolve => {
              drainTimer = setTimeout(() => resolve(false), shutdownDrainWaitMs);
            })]);
            const status = drainStatus();
            if (!drained && (status.pendingBefore > 0 || status.pendingAfter > 0)) {
              detachFencedStorage();
              await flush();
            }
          } finally { if (drainTimer !== undefined) clearTimeout(drainTimer); }
        }
        return Object.freeze({ missingResults, ...(storageFence
          ? { storageRevoked, detachedBefore, detachedAfter } : {}) });
      } finally {
        if (timer !== undefined) clearTimeout(timer);
        stopResults();
      }
    })().then(resolveShutdown, rejectShutdown);
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
    drainStatus,
    async dispose() {
      const stopped = stop();
      const receipt = await shutdown();
      await stopped;
      return receipt;
    },
  };
}

import { installDeepSeekObserver } from './deepseek-plugin.mjs';

/** One explicitly owned Cordis mount; the caller retains ownership of boundary storage. */
export function createDeepSeekHostPlugin({ boundary, identity, resolveIntent, onError } = {}) {
  if (typeof boundary?.before !== 'function' || typeof boundary?.after !== 'function') throw new TypeError('Boundary required');
  let observer = null;
  return {
    name: 'reflexmesh-deepseek-observer',
    apply(ctx) {
      if (observer) throw new Error('DeepSeek observer plugin is already mounted');
      const mounted = installDeepSeekObserver(ctx, { boundary, identity, resolveIntent, onError });
      observer = mounted;
      // Cordis awaits an async plugin disposer when fiber.dispose() is awaited.
      return async () => {
        try { await mounted.dispose(); }
        finally { if (observer === mounted) observer = null; }
      };
    },
    async flush() { await observer?.flush(); },
    get mounted() { return observer !== null; },
  };
}

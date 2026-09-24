import { SqliteKernel } from './sqlite-kernel.mjs';
import { TaskAwareBoundary } from './task-boundary.mjs';
import { ShadowBoundary, BOUNDARY_USES_KERNEL } from './shadow-boundary.mjs';

// The product Loader owns a synchronous SqliteKernel. Do not pass that raw
// handle to asynchronous observer work: a continuation may outlive unload.
const METHODS = Object.freeze(['registerPack', 'claim', 'append', 'complete',
  'abandon', 'inspect', 'observe']);
const SQLITE_METHODS = Object.freeze(Object.fromEntries(METHODS.map(name =>
  [name, SqliteKernel.prototype[name]])));
const issued = new WeakSet();

export function createDeepSeekStorageFence(kernel) {
  if (!kernel || Object.getPrototypeOf(kernel) !== SqliteKernel.prototype
    || METHODS.some(name => Object.hasOwn(kernel, name) || typeof SQLITE_METHODS[name] !== 'function')) {
    throw new TypeError('DeepSeek storage kernel required');
  }
  let revoked = false;
  const boundaryKernel = Object.freeze(Object.fromEntries(METHODS.map(name => [name, (...args) => {
    if (revoked) throw new Error('DeepSeek observer storage revoked');
    // SqliteKernel methods are synchronous. A timer cannot interleave a call.
    return SQLITE_METHODS[name].call(kernel, ...args);
  }])));
  const fence = Object.freeze({
    kernel: boundaryKernel,
    get revoked() { return revoked; },
    revoke() { revoked = true; },
  });
  issued.add(fence);
  return fence;
}

export function isDeepSeekStorageFence(fence, boundary) {
  return fence !== null && typeof fence === 'object' && issued.has(fence)
    && boundary !== null && typeof boundary === 'object'
    && Object.getPrototypeOf(boundary) === TaskAwareBoundary.prototype
    && !Object.hasOwn(boundary, 'before') && !Object.hasOwn(boundary, 'after')
    && ShadowBoundary.prototype[BOUNDARY_USES_KERNEL].call(boundary, fence.kernel);
}

import { ContractError } from '../dist/index.js';

const pause = new Int32Array(new SharedArrayBuffer(4));
/** Retry ONLY the idempotent journal-mode setup, never a transaction, decision or tool call.
 * SQLite may decline to invoke its busy handler during a lock upgrade to avoid deadlock.
 * Use a monotonic total contention budget; do not multiply busy_timeout by the retry count.
 */
export function configureJournal(db, { busyTimeoutMs, inMemory = false }) {
  if (!Number.isSafeInteger(busyTimeoutMs) || busyTimeoutMs < 0 || busyTimeoutMs > 10000) throw new ContractError('Invalid startup budget');
  const deadline = performance.now() + busyTimeoutMs;
  try {
    for (;;) {
      const remaining = Math.max(0, Math.ceil(deadline - performance.now()));
      db.exec(`PRAGMA busy_timeout=${remaining}`);
      try {
        const mode = db.prepare('PRAGMA journal_mode=WAL').get().journal_mode;
        if (mode !== (inMemory ? 'memory' : 'wal')) throw new ContractError('Requested journal mode unavailable');
        db.exec('PRAGMA synchronous=FULL');
        return;
      } catch (error) {
        // 5 is SQLITE_BUSY (including extended BUSY codes). Never retry errors by matching prose.
        const busy = error?.code === 'ERR_SQLITE_ERROR' && Number.isInteger(error.errcode) && (error.errcode & 0xff) === 5;
        const left = deadline - performance.now();
        if (!busy || busyTimeoutMs === 0 || left <= 0) throw error;
        Atomics.wait(pause, 0, 0, Math.min(10, left));
      }
    }
  } finally {
    db.exec(`PRAGMA busy_timeout=${busyTimeoutMs}`);
  }
}

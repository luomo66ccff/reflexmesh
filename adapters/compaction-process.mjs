import { fork } from 'node:child_process';
import { CompactionError } from './compaction-contract.mjs';

const spawnDefault = () => fork(new URL('./compaction-worker.mjs', import.meta.url), [], {
  execArgv: [], windowsHide: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
  env: Object.fromEntries(['PATH', 'Path', 'SystemRoot', 'WINDIR', 'TEMP', 'TMP']
    .filter(key => process.env[key] !== undefined).map(key => [key, process.env[key]])),
});
/** Internal fixed worker only. Injection belongs to trusted tests, never CLI input. */
export function runCompactionWorker(request, { timeoutMs = 30000, signal, spawnWorker = spawnDefault } = {}) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 300000)
    return Promise.reject(new CompactionError('invalid_options'));
  if (signal?.aborted) return Promise.reject(new CompactionError('compaction_cancelled'));
  return new Promise((resolve, reject) => {
    let child, receipt, failure, settled = false, killTimer;
    const finish = (code, result) => {
      if (settled) return;
      settled = true; clearTimeout(timer); clearTimeout(killTimer);
      signal?.removeEventListener('abort', cancel);
      if (code) reject(new CompactionError(code)); else resolve(result);
    };
    const stop = code => {
      if (failure || settled) return;
      failure = code;
      try { child.kill('SIGKILL'); } catch {}
      killTimer = setTimeout(() => {
        try { child.disconnect(); } catch {}
        child.unref(); finish('worker_termination_unconfirmed');
      }, 5000);
    };
    const cancel = () => stop('compaction_cancelled');
    const timer = setTimeout(() => stop('compaction_timeout'), timeoutMs);
    try { child = spawnWorker(); } catch { finish('worker_start_failed'); return; }
    child.on('message', message => {
      if (receipt !== undefined || !message || typeof message !== 'object'
        || Buffer.byteLength(JSON.stringify(message)) > 65536) { stop('worker_protocol_failed'); return; }
      receipt = message;
    });
    child.once('error', () => { failure ??= 'worker_start_failed'; });
    child.once('close', (code, exitSignal) => {
      if (failure) { finish(failure); return; }
      if (code !== 0 || exitSignal || receipt?.ok !== true) { finish('compaction_unverified'); return; }
      finish(null, receipt);
    });
    signal?.addEventListener('abort', cancel, { once: true });
    if (signal?.aborted) cancel();
    try { child.send(request, error => { if (error) stop('worker_send_failed'); }); }
    catch { stop('worker_send_failed'); }
  });
}

import { fork } from 'node:child_process';
import { BackupError, BACKUP_FAILURE_CODES } from './backup-files.mjs';

const workerUrl = new URL('./backup-worker.mjs', import.meta.url);
const forkWorker = () => fork(workerUrl, [], { execArgv: [], windowsHide: true,
  stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
  env: Object.fromEntries(['PATH', 'Path', 'SystemRoot', 'WINDIR', 'TEMP', 'TMP']
    .filter(key => process.env[key] !== undefined).map(key => [key, process.env[key]])) });

/** Internal runner. Test injection is trusted code, never a CLI/event option. */
export function runBackupWorker(request, { timeoutMs = 30000, signal, spawnWorker = forkWorker } = {}) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 300000)
    return Promise.reject(new BackupError('invalid_timeout'));
  if (signal?.aborted) return Promise.reject(new BackupError('backup_cancelled'));
  return new Promise((resolve, reject) => {
    let child, receipt, failure, settled = false, killTimer;
    const finish = (error, result) => {
      if (settled) return;
      settled = true; clearTimeout(timer); clearTimeout(killTimer);
      signal?.removeEventListener('abort', cancel);
      if (error) reject(new BackupError(error)); else resolve(result);
    };
    const stop = code => {
      if (failure || settled) return;
      failure = code;
      try { child.kill('SIGKILL'); } catch { /* Await close, never publish based on kill return. */ }
      killTimer = setTimeout(() => {
        // No claim that termination succeeded; incomplete output is retained.
        try { child.disconnect(); } catch {}
        child.unref();
        finish('worker_termination_unconfirmed');
      }, 5000);
    };
    const cancel = () => stop('backup_cancelled');
    const timer = setTimeout(() => stop('backup_timeout'), timeoutMs);
    try { child = spawnWorker(); }
    catch { finish('worker_start_failed'); return; }
    child.on('message', message => {
      if (receipt !== undefined || !message || typeof message !== 'object'
        || Buffer.byteLength(JSON.stringify(message)) > 65536) { stop('worker_protocol_failed'); return; }
      receipt = message;
    });
    child.once('error', () => { failure ??= 'worker_start_failed'; });
    child.once('close', (code, exitSignal) => {
      if (failure) { finish(failure); return; }
      if (code !== 0 || exitSignal || receipt?.ok !== true) {
        finish(!exitSignal && receipt?.ok === false && BACKUP_FAILURE_CODES.has(receipt.code)
          ? receipt.code : 'backup_verification_failed'); return;
      }
      finish(null, receipt);
    });
    signal?.addEventListener('abort', cancel, { once: true });
    if (signal?.aborted) cancel();
    try { child.send(request, error => { if (error) stop('worker_send_failed'); }); }
    catch { stop('worker_send_failed'); }
  });
}

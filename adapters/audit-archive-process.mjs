import { fork } from 'node:child_process';
import { runCompactionWorker } from './compaction-process.mjs';
import { AuditArchiveError } from './audit-archive-contract.mjs';

const spawnDefault = () => fork(new URL('./audit-archive-worker.mjs', import.meta.url), [], {
  execArgv: [], windowsHide: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
  env: Object.fromEntries(['PATH', 'Path', 'SystemRoot', 'WINDIR', 'TEMP', 'TMP']
    .filter(key => process.env[key] !== undefined).map(key => [key, process.env[key]])),
});
/** Reuse the tested bounded, kill-and-wait receipt protocol; no caller-selected module. */
export async function runAuditArchiveWorker(request, options = {}) {
  try { return await runCompactionWorker(request, { ...options, spawnWorker: spawnDefault }); }
  catch (error) {
    const code = { compaction_cancelled: 'archive_cancelled', compaction_timeout: 'archive_timeout',
      compaction_unverified: 'archive_unverified' }[error?.code] ?? error?.code;
    throw new AuditArchiveError(code);
  }
}

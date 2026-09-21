import { join } from 'node:path';
import { ledgerSnapshot, compactLedger } from './compaction-database.mjs';
import { logicalEquivalent, validateLedgerSnapshot } from './compaction-contract.mjs';
import { sourcePath, hashFile, noSidecars, regularFile, sha256 } from './backup-files.mjs';

let finished = false;
process.on('disconnect', () => { if (!finished) process.exit(1); });
function identity(path) {
  const stat = regularFile(path);
  return { pathDigest: sha256(process.platform === 'win32' ? path.toLowerCase() : path),
    device: String(stat.dev), inode: String(stat.ino) };
}
process.once('message', async request => {
  let reply;
  try {
    const path = sourcePath(request.source), source = identity(path);
    if (JSON.stringify(source) !== JSON.stringify(request.sourceIdentity)) throw new Error('source_changed');
    const backup = join(request.backupDirectory, 'ledger.sqlite');
    noSidecars(backup);
    const beforeBackup = hashFile(backup);
    if (beforeBackup.sha256 !== request.backup.sha256 || beforeBackup.bytes !== request.backup.bytes)
      throw new Error('backup_changed');
    if (request.operation === 'preview') {
      const snapshot = validateLedgerSnapshot(await ledgerSnapshot(path));
      const archived = validateLedgerSnapshot(await ledgerSnapshot(backup));
      if (!logicalEquivalent(snapshot, archived)) throw new Error('backup_not_equivalent');
      reply = { ok: true, snapshot };
    } else if (request.operation === 'apply') {
      const result = await compactLedger(path, { expectedSnapshot: validateLedgerSnapshot(request.snapshot), backupPath: backup });
      const before = validateLedgerSnapshot(result.before), after = validateLedgerSnapshot(result.after);
      if (result.logicalContentPreserved !== true || !logicalEquivalent(before, after)) throw new Error('logical_change');
      reply = { ok: true, before, after, logicalContentPreserved: true };
    } else throw new Error('invalid_operation');
    if (JSON.stringify(hashFile(backup)) !== JSON.stringify(beforeBackup)) throw new Error('backup_changed');
    noSidecars(backup);
    if (JSON.stringify(identity(path)) !== JSON.stringify(source)) throw new Error('source_changed');
  } catch { reply = { ok: false }; } // Never echo database content, paths or native errors.
  process.send?.(reply, error => {
    finished = true; process.exitCode = !error && reply.ok ? 0 : 1;
    if (process.connected) process.disconnect();
  });
});

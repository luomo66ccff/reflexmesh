import { join } from 'node:path';
import { SqliteKernel } from './sqlite-kernel.mjs';
import { previewAuditArchive, applyAuditArchive, queryArchivedAudit } from './audit-archive-database.mjs';
import { validateArchivePreview, archiveCheck as check } from './audit-archive-contract.mjs';
import { sourcePath, hashFile, noSidecars, regularFile, sha256 } from './backup-files.mjs';

let finished = false;
process.on('disconnect', () => { if (!finished) process.exit(1); });
function identity(path) {
  const stat = regularFile(path);
  return { pathDigest: sha256(process.platform === 'win32' ? path.toLowerCase() : path),
    device: String(stat.dev), inode: String(stat.ino) };
}
process.once('message', async request => {
  let reply, kernel;
  try {
    const path = sourcePath(request.source), source = identity(path);
    if (request.operation === 'history') {
      kernel = new SqliteKernel(path, { readOnly: true });
      reply = { ok: true, history: kernel.auditArchiveHistory(request.runKey, { after: request.after, limit: request.limit }) };
      check(reply.history !== null && reply.history !== undefined);
      kernel.close(); kernel = undefined;
    } else {
      const backup = join(request.backupDirectory, 'ledger.sqlite');
      noSidecars(backup);
      const beforeBackup = hashFile(backup);
      check(beforeBackup.sha256 === request.backup.sha256 && beforeBackup.bytes === request.backup.bytes);
      if (request.operation === 'query') {
        kernel = new SqliteKernel(path, { readOnly: true });
        const selected = kernel.auditArchiveBatch(request.runKey, request.batchId);
        check(selected && selected.batch.archiveSha256 === request.backup.sha256
          && selected.batch.archiveBytes === request.backup.bytes
          && selected.batch.sourceSchemaVersion === request.backup.ledgerSchemaVersion);
        kernel.close(); kernel = undefined;
        const query = queryArchivedAudit(backup, { runKey: request.runKey, cutoffAt: selected.batch.cutoffAt,
          highwaterSeq: selected.batch.highwaterSeq, expectedCoverage: selected.coverage,
          afterSeq: request.afterSeq ?? null, limit: request.limit, includeDetails: request.includeDetails });
        reply = { ok: true, query: { batchId: request.batchId, ...query } };
      } else {
        check(JSON.stringify(source) === JSON.stringify(request.sourceIdentity));
        if (request.operation === 'preview') {
          reply = { ok: true, preview: validateArchivePreview(previewAuditArchive(path, {
            backupPath: backup, cutoffAt: request.cutoffAt, maxRows: request.maxRows })) };
        } else if (request.operation === 'apply') {
          const result = await applyAuditArchive(path, { backupPath: backup, expectedPreview: validateArchivePreview(request.preview),
            batchId: request.batchId, archiveSha256: request.backup.sha256, archiveBytes: request.backup.bytes,
            committedAt: Date.now(), maxRows: request.maxRows });
          reply = { ok: true, ...result };
        } else check(false);
      }
      check(JSON.stringify(hashFile(backup)) === JSON.stringify(beforeBackup));
      noSidecars(backup);
    }
    check(JSON.stringify(identity(path)) === JSON.stringify(source));
  } catch { reply = { ok: false }; } // No raw database/native errors cross the worker boundary.
  finally { try { kernel?.close(); } catch { reply = { ok: false }; } }
  process.send?.(reply, error => {
    finished = true; process.exitCode = !error && reply.ok ? 0 : 1;
    if (process.connected) process.disconnect();
  });
});

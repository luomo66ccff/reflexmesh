import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { createBackupDatabase, inspectBackupDatabase } from './backup-database.mjs';
import { validateBackupManifest } from './backup-contract.mjs';
import { inspectSqliteRuntime } from './sqlite-runtime.mjs';
import { archiveDirectory, BackupError, BACKUP_FAILURE_CODES, directoryIdentity, fileIdentity, hashFile, noSidecars,
  readBounded, regularFile, sha256, sourcePath, writeExclusive } from './backup-files.mjs';

let finished = false;
process.on('disconnect', () => { if (!finished) process.exit(1); });
const fail = () => { throw new BackupError('archive_changed'); };
async function inspectStable(path) {
  noSidecars(path);
  const before = hashFile(path), metadata = await inspectBackupDatabase(path);
  noSidecars(path);
  const after = hashFile(path);
  if (JSON.stringify(before) !== JSON.stringify(after)) fail();
  return { ...metadata, file: after };
}
process.once('message', async request => {
  let reply;
  try {
    if (request?.operation === 'create') {
      const source = sourcePath(request.source);
      if (directoryIdentity(request.directory) !== request.directoryIdentity) fail();
      const path = join(request.directory, 'ledger.sqlite');
      writeExclusive(path, ''); // Native backup may overwrite only this exclusively reserved empty file.
      await createBackupDatabase(source, path);
      const { ledgerSchemaVersion, summary, file } = await inspectStable(path);
      const runtime = inspectSqliteRuntime();
      const manifest = validateBackupManifest({ schemaVersion: 1, kind: 'reflexmesh-ledger-backup',
        createdAt: new Date().toISOString(), ledgerSchemaVersion,
        database: { file: 'ledger.sqlite', bytes: file.bytes, sha256: file.sha256 },
        runtime: { nodeVersion: runtime.nodeVersion, sqliteVersion: runtime.sqliteVersion }, summary,
        checks: { integrity: 'ok', foreignKeys: 'ok', schema: 'recognized' },
        restoreAuthorized: false, retryAllowed: false });
      reply = { ok: true, manifest, identity: file.identity };
    } else if (request?.operation === 'verify') {
      const directory = archiveDirectory(request.directory);
      const manifestBytes = readBounded(join(directory, 'manifest.json'));
      const markerBytes = readBounded(join(directory, 'COMPLETE'), 1024);
      const marker = JSON.parse(markerBytes.toString('utf8'));
      if (Object.keys(marker).sort().join(',') !== 'manifestSha256,schemaVersion'
        || marker.schemaVersion !== 1 || marker.manifestSha256 !== sha256(manifestBytes))
        throw new BackupError('manifest_mismatch');
      const manifest = validateBackupManifest(JSON.parse(manifestBytes.toString('utf8')));
      const path = join(directory, 'ledger.sqlite');
      const { ledgerSchemaVersion, summary, file } = await inspectStable(path);
      if (file.bytes !== manifest.database.bytes || file.sha256 !== manifest.database.sha256
        || ledgerSchemaVersion !== manifest.ledgerSchemaVersion
        || !isDeepStrictEqual(summary, manifest.summary)) throw new BackupError('archive_mismatch');
      if (!readBounded(join(directory, 'manifest.json')).equals(manifestBytes)
        || !readBounded(join(directory, 'COMPLETE'), 1024).equals(markerBytes)) fail();
      archiveDirectory(directory);
      if (fileIdentity(regularFile(path)) !== file.identity) fail();
      reply = { ok: true, manifest, identity: file.identity };
    } else throw new BackupError('invalid_operation');
  } catch (error) {
    // Neither native SQLite error messages nor file paths cross the worker boundary.
    reply = { ok: false, code: BACKUP_FAILURE_CODES.has(error?.code) ? error.code : 'backup_verification_failed' };
  }
  process.send?.(reply, error => {
    finished = true;
    process.exitCode = !error && reply.ok ? 0 : 1;
    if (process.connected) process.disconnect();
  });
});

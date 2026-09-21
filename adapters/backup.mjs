import { join } from 'node:path';
import { unlinkSync } from 'node:fs';
import { assertSqliteWalRuntime } from './sqlite-runtime.mjs';
import { archiveDirectory, BackupError, directoryIdentity, fileIdentity, noSidecars, regularFile,
  reserveBackupDirectory, sha256, writeExclusive } from './backup-files.mjs';
import { runBackupWorker } from './backup-process.mjs';
import { validateBackupManifest } from './backup-contract.mjs';

function options(value, fields) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw new BackupError('invalid_options');
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(descriptors).some(key => typeof key !== 'string' || !fields.includes(key)
    || !Object.hasOwn(descriptors[key], 'value'))) throw new BackupError('invalid_options');
  const timeoutMs = value.timeoutMs ?? 30000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 300000
    || value.signal !== undefined && !(value.signal instanceof AbortSignal)) throw new BackupError('invalid_options');
  if (value.signal?.aborted) throw new BackupError('backup_cancelled');
  return timeoutMs;
}
const report = (manifest, operation) => Object.freeze({ schemaVersion: 1, kind: 'reflexmesh-backup-result',
  operation, status: 'verified_archive', manifest, sourceFreshness: 'not_attested',
  authenticity: 'not_attested', restoreAuthorized: false, retryAllowed: false });

export async function createLedgerBackup(input) {
  const timeoutMs = options(input, ['dbPath', 'outDir', 'timeoutMs', 'signal']);
  assertSqliteWalRuntime();
  const paths = reserveBackupDirectory(input.dbPath, input.outDir);
  const receipt = await runBackupWorker({ operation: 'create', source: paths.source,
    directory: paths.output, directoryIdentity: paths.directoryIdentity }, { timeoutMs, signal: input.signal });
  if (input.signal?.aborted) throw new BackupError('backup_cancelled');
  const manifest = validateBackupManifest(receipt.manifest);
  if (directoryIdentity(paths.output) !== paths.directoryIdentity) throw new BackupError('archive_changed');
  const path = join(paths.output, 'ledger.sqlite');
  noSidecars(path);
  if (fileIdentity(regularFile(path)) !== receipt.identity) throw new BackupError('archive_changed');
  const bytes = `${JSON.stringify(manifest)}\n`;
  writeExclusive(join(paths.output, 'manifest.json'), bytes);
  writeExclusive(join(paths.output, 'COMPLETE'), `${JSON.stringify({ schemaVersion: 1, manifestSha256: sha256(bytes) })}\n`);
  archiveDirectory(paths.output, { incomplete: true });
  const result = report(manifest, 'create');
  // Publication linearization point: no potentially failing file operation follows.
  // A crash before this unlink is not a usable archive; lost output after it is an unknown caller outcome.
  unlinkSync(join(paths.output, 'INCOMPLETE'));
  return result;
}

export async function verifyLedgerBackup(input) {
  const timeoutMs = options(input, ['directory', 'timeoutMs', 'signal']);
  const directory = archiveDirectory(input.directory), identity = directoryIdentity(directory);
  const receipt = await runBackupWorker({ operation: 'verify', directory }, { timeoutMs, signal: input.signal });
  if (input.signal?.aborted) throw new BackupError('backup_cancelled');
  const manifest = validateBackupManifest(receipt.manifest);
  archiveDirectory(directory);
  if (directoryIdentity(directory) !== identity
    || fileIdentity(regularFile(join(directory, 'ledger.sqlite'))) !== receipt.identity) throw new BackupError('archive_changed');
  return report(manifest, 'verify');
}

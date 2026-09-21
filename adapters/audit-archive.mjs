import { join, dirname, basename } from 'node:path';
import { mkdirSync, realpathSync, readdirSync, unlinkSync } from 'node:fs';
import { assertSqliteWalRuntime } from './sqlite-runtime.mjs';
import { verifyLedgerBackup } from './backup.mjs';
import { archiveDirectory, directoryIdentity, explicitLocalPath, readBounded, regularFile, sha256, sourcePath, writeExclusive } from './backup-files.mjs';
import { AuditArchiveError, archiveCheck as check, validateArchivePreview, validateAuditArchivePlan, validateArchiveReceipt } from './audit-archive-contract.mjs';
import { runAuditArchiveWorker } from './audit-archive-process.mjs';

function options(input, keys) {
  check(input && typeof input === 'object' && !Array.isArray(input)
    && [Object.prototype, null].includes(Object.getPrototypeOf(input)), 'invalid_options');
  const d = Object.getOwnPropertyDescriptors(input);
  check(Reflect.ownKeys(d).every(key => typeof key === 'string' && keys.includes(key)
    && Object.hasOwn(d[key], 'value')), 'invalid_options');
  const timeoutMs = input.timeoutMs ?? 30000;
  check(Number.isSafeInteger(timeoutMs) && timeoutMs >= 100 && timeoutMs <= 300000
    && (input.signal === undefined || input.signal instanceof AbortSignal), 'invalid_options');
  check(!input.signal?.aborted, 'archive_cancelled');
  return { timeoutMs, signal: input.signal };
}
const identity = path => {
  const stat = regularFile(path);
  return { pathDigest: sha256(process.platform === 'win32' ? path.toLowerCase() : path),
    device: String(stat.dev), inode: String(stat.ino) };
};
function distinct(path, directory) {
  const other = join(directory, 'ledger.sqlite'), a = regularFile(path), b = regularFile(other);
  check(path !== other && !(a.dev === b.dev && a.ino === b.ino), 'source_is_archive');
}
function outputPath(path, archive, selected) {
  const raw = explicitLocalPath(selected), output = join(realpathSync(dirname(raw)), basename(raw));
  const norm = p => process.platform === 'win32' ? p.toLowerCase().replaceAll('\\', '/') : p;
  check(norm(output) !== norm(archive) && !norm(output).startsWith(`${norm(archive)}/`)
    && !['', '-wal', '-shm', '-journal'].some(s => norm(output) === norm(path + s)), 'output_overlap');
  return output;
}
function planDirectory(value, allowAttempt = false) {
  const raw = explicitLocalPath(value); directoryIdentity(raw);
  const path = realpathSync(raw), files = readdirSync(path).sort();
  const expected = allowAttempt && files.includes('attempt') ? 'READY,attempt,plan.json' : 'READY,plan.json';
  check(files.join(',') === expected, 'invalid_plan_directory');
  for (const name of ['READY', 'plan.json']) regularFile(join(path, name));
  if (files.includes('attempt')) directoryIdentity(join(path, 'attempt'));
  return path;
}
function loadPlan(directory) {
  const bytes = readBounded(join(directory, 'plan.json')), batchId = sha256(bytes);
  check(readBounded(join(directory, 'READY'), 128).toString('utf8') === `${batchId}\n`);
  return { plan: validateAuditArchivePlan(JSON.parse(bytes.toString('utf8'))), batchId, bytes };
}
const safety = Object.freeze({ restoreAuthorized: false, retryAllowed: false, sourceAuthentication: 'not_attested',
  externalArchiveChain: 'not_verified', secureErasure: 'not_claimed' });
const backupBinding = result => ({ sha256: result.manifest.database.sha256, bytes: result.manifest.database.bytes,
  ledgerSchemaVersion: result.manifest.ledgerSchemaVersion });

export async function previewLedgerAuditArchive(input) {
  const worker = options(input, ['dbPath', 'backupDirectory', 'outDir', 'cutoffAt', 'maxRows', 'timeoutMs', 'signal']);
  const maxRows = input.maxRows ?? 10000;
  check(Number.isSafeInteger(input.cutoffAt) && input.cutoffAt >= 0 && Number.isSafeInteger(maxRows)
    && maxRows > 0 && maxRows <= 10000, 'invalid_options');
  const path = sourcePath(input.dbPath), source = identity(path), archive = archiveDirectory(input.backupDirectory);
  distinct(path, archive);
  const selectedOutput = outputPath(path, archive, input.outDir);
  const backup = backupBinding(await verifyLedgerBackup({ directory: archive, ...worker }));
  const receipt = await runAuditArchiveWorker({ operation: 'preview', source: path, sourceIdentity: source,
    backupDirectory: archive, backup, cutoffAt: input.cutoffAt, maxRows }, worker);
  check(!input.signal?.aborted, 'archive_cancelled');
  check(JSON.stringify(identity(path)) === JSON.stringify(source), 'source_changed');
  const plan = validateAuditArchivePlan({ schemaVersion: 1, kind: 'reflexmesh-audit-archive-plan',
    createdAt: new Date().toISOString(), source, backup, preview: validateArchivePreview(receipt.preview), maxRows,
    quiescenceRequired: true, deleteAuditRows: true, preserveExecutionGuards: true, restoreAuthorized: false, retryAllowed: false });
  directoryIdentity(dirname(selectedOutput));
  mkdirSync(selectedOutput, { mode: 0o700 });
  writeExclusive(join(selectedOutput, 'INCOMPLETE'), 'Unfinished audit archive plan; never apply.\n');
  const bytes = `${JSON.stringify(plan)}\n`, batchId = sha256(bytes);
  writeExclusive(join(selectedOutput, 'plan.json'), bytes);
  writeExclusive(join(selectedOutput, 'READY'), `${batchId}\n`);
  check(readdirSync(selectedOutput).sort().join(',') === 'INCOMPLETE,READY,plan.json', 'invalid_plan_directory');
  const result = Object.freeze({ status: 'preview', batchId, selection: plan.preview.selection,
    ledgerSchemaVersion: plan.preview.sourceSnapshot.ledgerSchemaVersion, backupEquivalent: true, ...safety });
  unlinkSync(join(selectedOutput, 'INCOMPLETE'));
  return result;
}

export async function applyLedgerAuditArchive(input) {
  const worker = options(input, ['dbPath', 'backupDirectory', 'planDirectory', 'quiescent', 'timeoutMs', 'signal']);
  check(input.quiescent === true, 'quiescence_required');
  assertSqliteWalRuntime();
  const directory = planDirectory(input.planDirectory), dirIdentity = directoryIdentity(directory);
  const { plan, batchId, bytes } = loadPlan(directory), path = sourcePath(input.dbPath);
  check(JSON.stringify(identity(path)) === JSON.stringify(plan.source), 'source_changed');
  const archive = archiveDirectory(input.backupDirectory); distinct(path, archive);
  const backup = backupBinding(await verifyLedgerBackup({ directory: archive, ...worker }));
  check(JSON.stringify(backup) === JSON.stringify(plan.backup), 'archive_changed');
  check(!input.signal?.aborted, 'archive_cancelled');
  check(directoryIdentity(directory) === dirIdentity && readBounded(join(directory, 'plan.json')).equals(bytes), 'plan_changed');
  const attempt = join(directory, 'attempt');
  mkdirSync(attempt, { mode: 0o700 });
  writeExclusive(join(attempt, 'UNCONFIRMED'), 'Outcome unknown; never automatically retry or restore.\n');
  writeExclusive(join(attempt, 'STARTED'), `${JSON.stringify({ schemaVersion: 1, batchId, retryAllowed: false })}\n`);
  try {
    const receipt = await runAuditArchiveWorker({ operation: 'apply', source: path, sourceIdentity: plan.source,
      backupDirectory: archive, backup, preview: plan.preview, batchId, maxRows: plan.maxRows }, worker);
    const result = Object.freeze({ schemaVersion: 1, kind: 'reflexmesh-audit-archive-result', status: 'verified_archival',
      ...validateArchiveReceipt(receipt, plan, batchId), ...safety });
    const resultBytes = `${JSON.stringify(result)}\n`;
    writeExclusive(join(attempt, 'result.json'), resultBytes);
    writeExclusive(join(attempt, 'COMPLETE'), `${sha256(resultBytes)}\n`);
    check(directoryIdentity(directory) === dirIdentity
      && readdirSync(attempt).sort().join(',') === 'COMPLETE,STARTED,UNCONFIRMED,result.json', 'invalid_receipt');
    unlinkSync(join(attempt, 'UNCONFIRMED'));
    return result;
  } catch (error) {
    throw new AuditArchiveError(error?.code === 'worker_termination_unconfirmed' ? 'apply_unknown_worker_unconfirmed' : 'apply_unknown');
  }
}

export function inspectAuditArchiveAttempt(value) {
  const directory = planDirectory(value, true), { plan, batchId } = loadPlan(directory);
  if (!readdirSync(directory).includes('attempt')) return { status: 'not_started', batchId, ...safety };
  const attempt = join(directory, 'attempt');
  if (readdirSync(attempt).sort().join(',') !== 'COMPLETE,STARTED,result.json') return { status: 'apply_unknown', batchId, ...safety };
  const started = JSON.parse(readBounded(join(attempt, 'STARTED'), 1024).toString('utf8'));
  const bytes = readBounded(join(attempt, 'result.json'));
  check(started.schemaVersion === 1 && started.batchId === batchId && started.retryAllowed === false
    && readBounded(join(attempt, 'COMPLETE'), 128).toString('utf8') === `${sha256(bytes)}\n`, 'invalid_receipt');
  const result = JSON.parse(bytes.toString('utf8'));
  check(result.status === 'verified_archival' && result.retryAllowed === false && result.restoreAuthorized === false, 'invalid_receipt');
  validateArchiveReceipt(result, plan, batchId);
  return { status: 'recorded_completion', batchId, currentLedgerVerified: false, ...safety };
}

export async function auditArchiveHistory(input) {
  const worker = options(input, ['dbPath', 'runKey', 'after', 'limit', 'timeoutMs', 'signal']);
  const receipt = await runAuditArchiveWorker({ operation: 'history', source: sourcePath(input.dbPath),
    runKey: input.runKey, after: input.after ?? '', limit: input.limit ?? 20 }, worker);
  return { status: 'history', ...receipt.history, ...safety };
}
export async function queryLedgerAuditArchive(input) {
  const worker = options(input, ['dbPath', 'runKey', 'batchId', 'backupDirectory', 'afterSeq', 'limit', 'includeDetails', 'timeoutMs', 'signal']);
  const path = sourcePath(input.dbPath), archive = archiveDirectory(input.backupDirectory);
  distinct(path, archive);
  const backup = backupBinding(await verifyLedgerBackup({ directory: archive, ...worker }));
  const receipt = await runAuditArchiveWorker({ operation: 'query', source: path, runKey: input.runKey,
    batchId: input.batchId, backupDirectory: archive, backup, afterSeq: input.afterSeq,
    limit: input.limit ?? 20, includeDetails: input.includeDetails ?? false }, worker);
  return { status: 'verified_batch', scope: 'one-batch', ...receipt.query, ...safety };
}

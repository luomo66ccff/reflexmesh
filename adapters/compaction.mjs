import { join, dirname, basename } from 'node:path';
import { mkdirSync, realpathSync, readdirSync, unlinkSync } from 'node:fs';
import { assertSqliteWalRuntime } from './sqlite-runtime.mjs';
import { verifyLedgerBackup } from './backup.mjs';
import { archiveDirectory, directoryIdentity, explicitLocalPath, readBounded, regularFile, sha256, sourcePath, writeExclusive } from './backup-files.mjs';
import { CompactionError, logicalEquivalent, validateCompactionPlan, validateLedgerSnapshot } from './compaction-contract.mjs';
import { runCompactionWorker } from './compaction-process.mjs';

function options(input, keys) {
  if (!input || typeof input !== 'object' || Array.isArray(input)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(input))) throw new CompactionError('invalid_options');
  const descriptors = Object.getOwnPropertyDescriptors(input);
  if (Reflect.ownKeys(descriptors).some(key => typeof key !== 'string' || !keys.includes(key)
    || !Object.hasOwn(descriptors[key], 'value'))) throw new CompactionError('invalid_options');
  const timeoutMs = input.timeoutMs ?? 30000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 300000
    || input.signal !== undefined && !(input.signal instanceof AbortSignal)) throw new CompactionError('invalid_options');
  if (input.signal?.aborted) throw new CompactionError('compaction_cancelled');
  return { timeoutMs, signal: input.signal };
}
function identity(path) {
  const stat = regularFile(path);
  return { pathDigest: sha256(process.platform === 'win32' ? path.toLowerCase() : path),
    device: String(stat.dev), inode: String(stat.ino) };
}
function distinctBackup(path, backupDirectory) {
  const backup = join(backupDirectory, 'ledger.sqlite');
  const a = regularFile(path), b = regularFile(backup);
  if (path === backup || a.dev === b.dev && a.ino === b.ino) throw new CompactionError('source_is_backup');
}
function safeOutput(path, backupDirectory, value) {
  const selected = explicitLocalPath(value), output = join(realpathSync(dirname(selected)), basename(selected));
  const norm = value => process.platform === 'win32' ? value.toLowerCase().replaceAll('\\', '/') : value;
  const out = norm(output), archive = norm(backupDirectory);
  if (out === archive || out.startsWith(`${archive}/`)
    || ['', '-wal', '-shm', '-journal'].some(suffix => out === norm(path + suffix)))
    throw new CompactionError('output_overlap');
  return output;
}
function reserve(value) {
  const selected = explicitLocalPath(value), parent = realpathSync(dirname(selected));
  directoryIdentity(parent);
  const output = join(parent, basename(selected));
  mkdirSync(output, { mode: 0o700 });
  writeExclusive(join(output, 'INCOMPLETE'), 'Unfinished compaction plan; never apply.\n');
  return output;
}
function planDirectory(value, allowAttempt = false) {
  const selected = explicitLocalPath(value);
  directoryIdentity(selected);
  const path = realpathSync(selected), files = readdirSync(path).sort();
  const expected = allowAttempt && files.includes('attempt') ? ['READY', 'attempt', 'plan.json'] : ['READY', 'plan.json'];
  if (files.join(',') !== expected.sort().join(',')) throw new CompactionError('invalid_plan_directory');
  for (const name of ['READY', 'plan.json']) regularFile(join(path, name));
  if (files.includes('attempt')) directoryIdentity(join(path, 'attempt'));
  return path;
}
function loadPlan(directory) {
  const bytes = readBounded(join(directory, 'plan.json'));
  const marker = readBounded(join(directory, 'READY'), 128).toString('utf8');
  if (marker !== `${sha256(bytes)}\n`) throw new CompactionError('invalid_plan');
  return { plan: validateCompactionPlan(JSON.parse(bytes.toString('utf8'))), planDigest: sha256(bytes), bytes };
}
const safety = Object.freeze({ deleteRows: false, restoreAuthorized: false, retryAllowed: false,
  sourceAuthentication: 'not_attested', secureErasure: 'not_claimed' });

export async function previewLedgerCompaction(input) {
  const workerOptions = options(input, ['dbPath', 'backupDirectory', 'outDir', 'timeoutMs', 'signal']);
  const path = sourcePath(input.dbPath), source = identity(path);
  const backupDirectory = archiveDirectory(input.backupDirectory);
  distinctBackup(path, backupDirectory);
  const selectedOutput = safeOutput(path, backupDirectory, input.outDir);
  const verified = await verifyLedgerBackup({ directory: backupDirectory, ...workerOptions });
  const backup = { sha256: verified.manifest.database.sha256, bytes: verified.manifest.database.bytes,
    ledgerSchemaVersion: verified.manifest.ledgerSchemaVersion };
  const receipt = await runCompactionWorker({ operation: 'preview', source: path,
    sourceIdentity: source, backupDirectory, backup }, workerOptions);
  if (input.signal?.aborted) throw new CompactionError('compaction_cancelled');
  if (JSON.stringify(identity(path)) !== JSON.stringify(source)) throw new CompactionError('source_changed');
  const plan = validateCompactionPlan({ schemaVersion: 1, kind: 'reflexmesh-ledger-compaction-plan',
    createdAt: new Date().toISOString(), source, backup, snapshot: validateLedgerSnapshot(receipt.snapshot),
    quiescenceRequired: true, preservesAllRows: true, deleteRows: false, restoreAuthorized: false, retryAllowed: false });
  const output = reserve(selectedOutput), bytes = `${JSON.stringify(plan)}\n`;
  writeExclusive(join(output, 'plan.json'), bytes);
  writeExclusive(join(output, 'READY'), `${sha256(bytes)}\n`);
  if (readdirSync(output).sort().join(',') !== 'INCOMPLETE,READY,plan.json') throw new CompactionError('invalid_plan_directory');
  const result = { schemaVersion: 1, kind: 'reflexmesh-compaction-result', status: 'preview',
    planDigest: sha256(bytes), snapshot: plan.snapshot, backupEquivalent: true, ...safety };
  unlinkSync(join(output, 'INCOMPLETE'));
  return Object.freeze(result);
}

export async function applyLedgerCompaction(input) {
  const workerOptions = options(input, ['dbPath', 'backupDirectory', 'planDirectory', 'quiescent', 'timeoutMs', 'signal']);
  if (input.quiescent !== true) throw new CompactionError('quiescence_required');
  assertSqliteWalRuntime(); // Before reservation or writable database open.
  const directory = planDirectory(input.planDirectory), dirIdentity = directoryIdentity(directory);
  const { plan, planDigest, bytes } = loadPlan(directory);
  const path = sourcePath(input.dbPath);
  if (JSON.stringify(identity(path)) !== JSON.stringify(plan.source)) throw new CompactionError('source_changed');
  const backupDirectory = archiveDirectory(input.backupDirectory);
  distinctBackup(path, backupDirectory);
  const verified = await verifyLedgerBackup({ directory: backupDirectory, ...workerOptions });
  if (verified.manifest.database.sha256 !== plan.backup.sha256 || verified.manifest.database.bytes !== plan.backup.bytes
    || verified.manifest.ledgerSchemaVersion !== plan.backup.ledgerSchemaVersion) throw new CompactionError('backup_changed');
  if (input.signal?.aborted) throw new CompactionError('compaction_cancelled');
  if (directoryIdentity(directory) !== dirIdentity || !readBounded(join(directory, 'plan.json')).equals(bytes))
    throw new CompactionError('plan_changed');
  const attempt = join(directory, 'attempt');
  mkdirSync(attempt, { mode: 0o700 }); // Atomic at-most-one dispatch per plan, including uncertain outcomes.
  writeExclusive(join(attempt, 'UNCONFIRMED'), 'Outcome unconfirmed; never automatically retry.\n');
  writeExclusive(join(attempt, 'STARTED'), `${JSON.stringify({ schemaVersion: 1, planDigest, retryAllowed: false })}\n`);
  try {
    const receipt = await runCompactionWorker({ operation: 'apply', source: path, sourceIdentity: plan.source,
      backupDirectory, backup: plan.backup, snapshot: plan.snapshot }, workerOptions);
    const before = validateLedgerSnapshot(receipt.before), after = validateLedgerSnapshot(receipt.after);
    if (receipt.logicalContentPreserved !== true || !logicalEquivalent(before, after)
      || !logicalEquivalent(before, plan.snapshot)) throw new CompactionError('compaction_unverified');
    const result = Object.freeze({ schemaVersion: 1, kind: 'reflexmesh-compaction-result', status: 'verified_compaction',
      planDigest, before, after, logicalContentPreserved: true,
      logicalPageBytesBefore: before.pages.pageSize * before.pages.pageCount,
      logicalPageBytesAfter: after.pages.pageSize * after.pages.pageCount,
      physicalBytesFreed: null, ...safety });
    const resultBytes = `${JSON.stringify(result)}\n`;
    writeExclusive(join(attempt, 'result.json'), resultBytes);
    writeExclusive(join(attempt, 'COMPLETE'), `${sha256(resultBytes)}\n`);
    if (directoryIdentity(directory) !== dirIdentity
      || readdirSync(attempt).sort().join(',') !== 'COMPLETE,STARTED,UNCONFIRMED,result.json')
      throw new CompactionError('invalid_receipt');
    // Final publication step. No fallible filesystem operation follows it.
    unlinkSync(join(attempt, 'UNCONFIRMED'));
    return result;
  } catch (error) {
    // A successful VACUUM may precede a crash, timeout, close error or lost response.
    // Keep the spent attempt; never claim rollback or automatically dispatch again.
    throw new CompactionError(error?.code === 'worker_termination_unconfirmed'
      ? 'apply_unknown_worker_unconfirmed' : 'apply_unknown');
  }
}

export function inspectCompactionAttempt(value) {
  const directory = planDirectory(value, true), { plan, planDigest } = loadPlan(directory);
  if (!readdirSync(directory).includes('attempt')) return { status: 'not_started', planDigest, ...safety };
  const attempt = join(directory, 'attempt'), files = readdirSync(attempt).sort();
  if (files.join(',') !== 'COMPLETE,STARTED,result.json') return { status: 'apply_unknown', planDigest, ...safety };
  const started = JSON.parse(readBounded(join(attempt, 'STARTED'), 1024).toString('utf8'));
  const bytes = readBounded(join(attempt, 'result.json'));
  if (started.planDigest !== planDigest || started.retryAllowed !== false
    || readBounded(join(attempt, 'COMPLETE'), 128).toString('utf8') !== `${sha256(bytes)}\n`)
    throw new CompactionError('invalid_receipt');
  const result = JSON.parse(bytes.toString('utf8'));
  if (result.planDigest !== planDigest || result.status !== 'verified_compaction' || result.retryAllowed !== false
    || result.logicalContentPreserved !== true || !logicalEquivalent(validateLedgerSnapshot(result.before), validateLedgerSnapshot(result.after))
    || !logicalEquivalent(result.before, plan.snapshot))
    throw new CompactionError('invalid_receipt');
  return { status: 'recorded_completion', planDigest, currentLedgerVerified: false, ...safety };
}

import { createRequire } from 'node:module';
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync } from 'node:fs';
import { basename, isAbsolute } from 'node:path';
import { SqliteKernel } from './sqlite-kernel.mjs';
import { assertSqliteWalRuntime } from './sqlite-runtime.mjs';
import { fileIdentity, sameOpenedFile } from './backup-files.mjs';

const requireBuiltin = createRequire(import.meta.url);
const TABLE_SQL = Object.freeze({
  packs: `CREATE TABLE packs (id TEXT NOT NULL, version TEXT NOT NULL, digest TEXT NOT NULL,
    body TEXT NOT NULL, PRIMARY KEY(id, version)) STRICT`,
  runs: `CREATE TABLE runs (key TEXT PRIMARY KEY, request_digest TEXT NOT NULL,
    state TEXT NOT NULL CHECK(state IN ('admitted','executing','completed','unknown')),
    epoch INTEGER NOT NULL, owner TEXT NOT NULL, lease_until INTEGER NOT NULL,
    evidence TEXT NOT NULL, result TEXT) STRICT`,
  audit: `CREATE TABLE audit (seq INTEGER PRIMARY KEY, run_key TEXT NOT NULL REFERENCES runs(key),
    kind TEXT NOT NULL, details TEXT NOT NULL, at INTEGER NOT NULL) STRICT`,
  observations: `CREATE TABLE observations (run_key TEXT NOT NULL REFERENCES runs(key), id TEXT NOT NULL,
    body TEXT NOT NULL, PRIMARY KEY(run_key,id)) STRICT`,
  labels: `CREATE TABLE labels (run_key TEXT NOT NULL REFERENCES runs(key), id TEXT NOT NULL,
    body TEXT NOT NULL, PRIMARY KEY(run_key,id)) STRICT`,
  recovery_reviews: `CREATE TABLE recovery_reviews (run_key TEXT NOT NULL REFERENCES runs(key), id TEXT NOT NULL,
    body TEXT NOT NULL, digest TEXT NOT NULL, applied_epoch INTEGER NOT NULL,
    at INTEGER NOT NULL, PRIMARY KEY(run_key,id), UNIQUE(run_key,applied_epoch)) STRICT`,
  claude_hook_pairs: `CREATE TABLE claude_hook_pairs (key TEXT PRIMARY KEY, token TEXT NOT NULL,
    call_digest TEXT NOT NULL, action_digest TEXT NOT NULL, deployment_digest TEXT NOT NULL,
    request_digest TEXT, state TEXT NOT NULL CHECK(state IN ('pending','ready','blocked')),
    reason_code TEXT CHECK(reason_code IN ('duplicate_pre','legacy_unpaired','before_failed',
      'unpaired_post','early_post','token_mismatch','descriptor_mismatch','decision_mismatch',
      'run_missing','action_mismatch','deployment_mismatch','request_mismatch','outcome_conflict',
      'invalid_state')), CHECK((state='blocked')=(reason_code IS NOT NULL))) STRICT`,
});
const COLUMNS = Object.freeze({
  packs: ['id:TEXT:1:1', 'version:TEXT:1:2', 'digest:TEXT:1:0', 'body:TEXT:1:0'],
  runs: ['key:TEXT:1:1', 'request_digest:TEXT:1:0', 'state:TEXT:1:0', 'epoch:INTEGER:1:0',
    'owner:TEXT:1:0', 'lease_until:INTEGER:1:0', 'evidence:TEXT:1:0', 'result:TEXT:0:0'],
  audit: ['seq:INTEGER:0:1', 'run_key:TEXT:1:0', 'kind:TEXT:1:0', 'details:TEXT:1:0', 'at:INTEGER:1:0'],
  observations: ['run_key:TEXT:1:1', 'id:TEXT:1:2', 'body:TEXT:1:0'],
  labels: ['run_key:TEXT:1:1', 'id:TEXT:1:2', 'body:TEXT:1:0'],
  recovery_reviews: ['run_key:TEXT:1:1', 'id:TEXT:1:2', 'body:TEXT:1:0', 'digest:TEXT:1:0',
    'applied_epoch:INTEGER:1:0', 'at:INTEGER:1:0'],
  claude_hook_pairs: ['key:TEXT:1:1', 'token:TEXT:1:0', 'call_digest:TEXT:1:0',
    'action_digest:TEXT:1:0', 'deployment_digest:TEXT:1:0', 'request_digest:TEXT:0:0',
    'state:TEXT:1:0', 'reason_code:TEXT:0:0'],
});
const TABLES = Object.freeze(['packs', 'runs', 'audit', 'observations', 'labels', 'recovery_reviews', 'claude_hook_pairs']);
const FOREIGN_TABLES = new Set(['audit', 'observations', 'labels', 'recovery_reviews']);
// Normalize DDL formatting only; neither case nor whitespace inside literals is cosmetic.
function fixed(sql) {
  if (typeof sql !== 'string') return '';
  let normalized = '';
  let literal = false;
  for (let i = 0; i < sql.length; i++) {
    const char = sql[i];
    if (char === "'") {
      normalized += char;
      if (literal && sql[i + 1] === "'") normalized += sql[++i];
      else literal = !literal;
    } else if (literal || !/\s/.test(char)) normalized += char;
  }
  return normalized.replace(/^CREATETABLEIFNOTEXISTS/, 'CREATETABLE')
    .replace(/^CREATEINDEXIFNOTEXISTS/, 'CREATEINDEX');
}

export class BackupDatabaseError extends Error {
  constructor(code) { super(code); this.name = 'BackupDatabaseError'; this.code = code; }
}
const fail = code => { throw new BackupDatabaseError(code); };
const check = (ok, code) => { if (!ok) fail(code); };

function tableNames(version) { return TABLES.slice(0, version === 1 ? 5 : version === 2 ? 6 : 7); }
function indexColumns(db, name) {
  check(/^[A-Za-z_][A-Za-z_0-9]*$/.test(name), 'backup_schema_unrecognized');
  return db.prepare(`PRAGMA index_info(${name})`).all().map(row => row.name);
}

/** Metadata/constraint recognition only; never parses user evidence or claims semantic correctness. */
export function recognizedSchema(db) {
  const version = db.prepare('PRAGMA user_version').get()?.user_version;
  check([1, 2, 3].includes(version), 'backup_schema_unrecognized');
  const expected = tableNames(version);
  const objects = db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE name NOT GLOB 'sqlite_*'").all();
  const listed = objects.filter(row => row.type === 'table');
  check(listed.length === expected.length && listed.every(row => expected.includes(row.name)), 'backup_schema_unrecognized');
  const extras = objects.filter(row => row.type !== 'table');
  check(extras.every(row => row.type === 'index' && row.name === 'runs_recovery_scan'
    && row.tbl_name === 'runs' && fixed(row.sql) === 'CREATEINDEXruns_recovery_scanONruns(state,key)'),
    'backup_schema_unrecognized');
  check(version < 3 || extras.length === 1, 'backup_schema_unrecognized');
  const strict = new Map(db.prepare('PRAGMA table_list').all()
    .filter(row => row.schema === 'main' && expected.includes(row.name)).map(row => [row.name, row]));
  for (const table of expected) {
    const definition = listed.find(row => row.name === table);
    check(fixed(definition?.sql) === fixed(TABLE_SQL[table]), 'backup_schema_unrecognized');
    check(strict.get(table)?.type === 'table' && strict.get(table)?.strict === 1
      && strict.get(table)?.wr === 0, 'backup_schema_unrecognized');
    const columns = db.prepare(`PRAGMA table_xinfo(${table})`).all();
    check(columns.length === COLUMNS[table].length
      && columns.every((column, i) => `${column.name}:${column.type}:${column.notnull}:${column.pk}` === COLUMNS[table][i]
        && column.hidden === 0 && column.dflt_value === null), 'backup_schema_unrecognized');
    const foreign = db.prepare(`PRAGMA foreign_key_list(${table})`).all();
    check(foreign.length === (FOREIGN_TABLES.has(table) ? 1 : 0), 'backup_schema_unrecognized');
    if (FOREIGN_TABLES.has(table)) {
      const row = foreign[0];
      check(row.table === 'runs' && row.from === 'run_key' && row.to === 'key'
        && row.on_update === 'NO ACTION' && row.on_delete === 'NO ACTION', 'backup_schema_unrecognized');
    }
  }
  if (version >= 2) {
    const unique = db.prepare('PRAGMA index_list(recovery_reviews)').all();
    check(unique.some(index => index.unique === 1 && indexColumns(db, index.name).join(',') === 'run_key,applied_epoch'),
      'backup_schema_unrecognized');
  }
  if (version === 3) {
    const index = db.prepare("SELECT type,tbl_name FROM sqlite_schema WHERE name='runs_recovery_scan'").get();
    check(index?.type === 'index' && index.tbl_name === 'runs'
      && indexColumns(db, 'runs_recovery_scan').join(',') === 'state,key', 'backup_schema_unrecognized');
  }
  return version;
}

function regularFile(path, code, empty = false) {
  check(typeof path === 'string' && isAbsolute(path) && path.length > 0, code);
  let stat;
  try { stat = lstatSync(path); } catch { fail(code); }
  check(stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1
    && Number.isSafeInteger(stat.size) && (!empty || stat.size === 0), code);
  return stat;
}
function noSidecars(path) {
  for (const suffix of ['-wal', '-shm', '-journal']) {
    try { lstatSync(path + suffix); } catch (error) { if (error?.code === 'ENOENT') continue; fail('backup_sidecar_present'); }
    fail('backup_sidecar_present');
  }
}
const SQLITE_MAGIC = Buffer.from('SQLite format 3\0', 'ascii');
function rollbackJournalHeader(path) {
  let fd;
  let header;
  try {
    const before = lstatSync(path, { bigint: true });
    check(before.isFile() && !before.isSymbolicLink() && before.nlink === 1n && before.size >= 20n,
      'backup_source_invalid');
    const pathIdentity = fileIdentity(before);
    fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const current = fstatSync(fd, { bigint: true });
    check(current.isFile() && current.nlink === 1n && sameOpenedFile(before, current), 'backup_source_invalid');
    const handleIdentity = fileIdentity(current);
    header = Buffer.alloc(20);
    check(readSync(fd, header, 0, header.length, 0) === header.length, 'backup_source_invalid');
    const after = lstatSync(path, { bigint: true });
    check(fileIdentity(fstatSync(fd, { bigint: true })) === handleIdentity
      && after.isFile() && !after.isSymbolicLink() && after.nlink === 1n
      && fileIdentity(after) === pathIdentity, 'backup_source_invalid');
  } catch (error) {
    if (error instanceof BackupDatabaseError) throw error;
    fail('backup_source_invalid');
  } finally {
    if (fd !== undefined) try { closeSync(fd); } catch { fail('backup_source_invalid'); }
  }
  check(header.subarray(0, SQLITE_MAGIC.length).equals(SQLITE_MAGIC), 'backup_source_invalid');
  check(header[18] === 1 && header[19] === 1, 'backup_journal_not_delete');
}
function sqliteApi() {
  try {
    const api = requireBuiltin('node:sqlite');
    check(typeof api.DatabaseSync === 'function' && typeof api.backup === 'function', 'backup_runtime_unsupported');
    return api;
  } catch (error) {
    if (error instanceof BackupDatabaseError) throw error;
    fail('backup_runtime_unsupported');
  }
}
function storageSummary(path, expectedVersion) {
  let kernel;
  try {
    kernel = new SqliteKernel(path, { readOnly: true });
    const summary = kernel.storageSnapshot({ scanLimit: 1000 });
    check(summary.ledgerSchemaVersion === expectedVersion, 'backup_schema_unrecognized');
    return summary;
  } catch (error) {
    if (error instanceof BackupDatabaseError) throw error;
    fail('backup_schema_unrecognized');
  } finally { try { kernel?.close(); } catch { fail('backup_failed'); } }
}
function inspectOpened(db, requireDelete) {
  const version = recognizedSchema(db);
  if (requireDelete) check(db.prepare('PRAGMA journal_mode').get()?.journal_mode === 'delete', 'backup_journal_not_delete');
  check(db.prepare('PRAGMA integrity_check(1)').get()?.integrity_check === 'ok', 'backup_integrity_failed');
  check(db.prepare('PRAGMA foreign_key_check').get() === undefined, 'backup_foreign_keys_failed');
  return version;
}

/** Read-only verification. No schema migration, journal repair, or user-file creation. */
export async function inspectBackupDatabase(path) {
  regularFile(path, 'backup_source_invalid');
  check(basename(path) === 'ledger.sqlite', 'backup_source_invalid');
  noSidecars(path);
  rollbackJournalHeader(path);
  const { DatabaseSync } = sqliteApi();
  let db, version, failure = null;
  try {
    db = new DatabaseSync(path, { readOnly: true });
    version = inspectOpened(db, true);
  } catch (error) { failure = error instanceof BackupDatabaseError ? error : new BackupDatabaseError('backup_failed'); }
  finally { try { db?.close(); } catch { failure ??= new BackupDatabaseError('backup_failed'); } }
  if (failure) throw failure;
  noSidecars(path);
  const summary = storageSummary(path, version);
  check(regularFile(path, 'backup_source_invalid').size === summary.pages.logicalBytes, 'backup_integrity_failed');
  noSidecars(path);
  return Object.freeze({ ledgerSchemaVersion: version, summary });
}

/** Copy an owned, exclusive empty target using SQLite's native online backup. */
export async function createBackupDatabase(sourcePath, targetPath) {
  try { assertSqliteWalRuntime(); } catch { fail('backup_runtime_unsupported'); }
  const { DatabaseSync, backup } = sqliteApi();
  regularFile(sourcePath, 'backup_source_invalid');
  regularFile(targetPath, 'backup_destination_invalid', true);
  check(basename(targetPath) === 'ledger.sqlite' && sourcePath !== targetPath, 'backup_destination_invalid');
  noSidecars(targetPath);
  let source, version, failure = null, began = false;
  try {
    source = new DatabaseSync(sourcePath, { readOnly: true });
    source.exec('BEGIN'); began = true;
    version = recognizedSchema(source); // Pins the read snapshot before online backup starts.
    await backup(source, targetPath);
  } catch (error) { failure = error instanceof BackupDatabaseError ? error : new BackupDatabaseError('backup_failed'); }
  finally {
    if (began) try { source.exec('ROLLBACK'); } catch { failure ??= new BackupDatabaseError('backup_failed'); }
    try { source?.close(); } catch { failure ??= new BackupDatabaseError('backup_failed'); }
  }
  if (failure) throw failure;
  regularFile(targetPath, 'backup_destination_invalid');
  let destination;
  failure = null;
  try {
    destination = new DatabaseSync(targetPath);
    check(destination.prepare('PRAGMA journal_mode=DELETE').get()?.journal_mode === 'delete', 'backup_journal_not_delete');
    check(inspectOpened(destination, true) === version, 'backup_schema_unrecognized');
  } catch (error) { failure = error instanceof BackupDatabaseError ? error : new BackupDatabaseError('backup_failed'); }
  finally { try { destination?.close(); } catch { failure ??= new BackupDatabaseError('backup_failed'); } }
  if (failure) throw failure;
  noSidecars(targetPath);
  return inspectBackupDatabase(targetPath);
}

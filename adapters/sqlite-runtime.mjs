import { createRequire } from 'node:module';

const requireBuiltin = createRequire(import.meta.url);
const VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const FIXED_ERROR = 'Persistent SQLite WAL writes require a recognized WAL-reset fix';

function parsedVersion(value) {
  if (typeof value !== 'string' || value.length > 32 || !VERSION.test(value)) return null;
  const parts = value.split('.').map(Number);
  return parts.every(Number.isSafeInteger) ? parts : null;
}

/** Version classification only. This is not a general SQLite safety certificate. */
export function classifySqliteVersion(version) {
  const parts = parsedVersion(version);
  if (!parts || parts[0] !== 3 || parts[1] < 7) return 'unknown';
  const [, minor, patch] = parts;
  if (minor > 51 || minor === 51 && patch >= 3
    || minor === 50 && patch >= 7 || minor === 44 && patch >= 6) return 'present';
  return 'affected';
}

function report(nodeVersion, sqliteVersion, probeStatus) {
  const walResetFix = probeStatus === 'ok' ? classifySqliteVersion(sqliteVersion) : 'unknown';
  return Object.freeze({ schemaVersion: 1, nodeVersion, sqliteVersion,
    walResetFix, persistentWriteAllowed: walResetFix === 'present', probeStatus });
}

/** Probes an independent in-memory SQLite connection; never opens a user path. */
export function inspectSqliteRuntime() {
  const nodeVersion = parsedVersion(process.versions?.node) ? process.versions.node : null;
  let DatabaseSync;
  try { ({ DatabaseSync } = requireBuiltin('node:sqlite')); }
  catch { return report(nodeVersion, null, 'module_unavailable'); }
  let db, rawVersion, failed = false;
  try {
    db = new DatabaseSync(':memory:');
    rawVersion = db.prepare('SELECT sqlite_version() AS version').get()?.version;
  } catch { failed = true; }
  finally {
    if (db) try { db.close(); } catch { failed = true; }
  }
  if (failed) return report(nodeVersion, null, 'probe_failed');
  if (!parsedVersion(rawVersion)) return report(nodeVersion, null, 'invalid_version');
  return report(nodeVersion, rawVersion, 'ok');
}

export class SqliteRuntimeError extends Error {
  constructor() {
    super(FIXED_ERROR);
    this.name = 'SqliteRuntimeError';
    this.code = 'SQLITE_WAL_RUNTIME_UNSUPPORTED';
  }
}

/** No caller-controlled version, option or environment override. */
export function assertSqliteWalRuntime() {
  const runtime = inspectSqliteRuntime();
  if (!runtime.persistentWriteAllowed) throw new SqliteRuntimeError();
  return runtime;
}

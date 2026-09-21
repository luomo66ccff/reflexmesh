import { SqliteKernel } from '../../adapters/sqlite-kernel.mjs';
import { DatabaseSync, StatementSync } from 'node:sqlite';

// Fixture-only SQLite operation labels: never send SQL, paths or exception text over IPC.
const operation = sql => {
  if (typeof sql !== 'string') return 'unknown';
  if (sql.startsWith('PRAGMA user_version')) return 'schema_version_read';
  if (sql.startsWith('PRAGMA journal_mode=WAL')) return 'journal_mode';
  if (sql.startsWith('PRAGMA synchronous=FULL')) return 'synchronous';
  if (sql.startsWith('PRAGMA busy_timeout=')) return 'busy_timeout';
  if (sql.startsWith('BEGIN IMMEDIATE')) return 'begin_immediate';
  if (sql.includes('CREATE TABLE IF NOT EXISTS')) return 'schema_ddl';
  if (sql.startsWith('COMMIT')) return 'commit';
  if (sql.startsWith('ROLLBACK')) return 'rollback';
  return 'other_sql';
};
const errorOperations = new WeakMap();
const statementOperations = new WeakMap();
for (const name of ['prepare', 'exec']) {
  const original = DatabaseSync.prototype[name];
  DatabaseSync.prototype[name] = function(sql, ...rest) {
    const phase = operation(sql);
    try {
      const result = Reflect.apply(original, this, [sql, ...rest]);
      if (name === 'prepare') statementOperations.set(result, phase);
      return result;
    } catch (error) {
      if (error && typeof error === 'object') errorOperations.set(error, phase);
      throw error;
    }
  };
}
for (const name of ['get', 'run']) {
  const original = StatementSync.prototype[name];
  StatementSync.prototype[name] = function(...args) {
    try { return Reflect.apply(original, this, args); }
    catch (error) {
      if (error && typeof error === 'object') errorOperations.set(error, statementOperations.get(this) ?? 'other_sql');
      throw error;
    }
  };
}
let kernel, failure;
const openStartedAt = performance.now();
try { kernel = new SqliteKernel(process.argv[2], process.argv[3] === '--busy-100' ? { busyTimeoutMs: 100 } : undefined); }
catch (error) { failure = { kind: 'fixture_error', stage: 'open', sqliteOperation: errorOperations.get(error) ?? 'database_open',
  code: error.code ?? 'unknown', errcode: error.errcode ?? null,
  elapsedMs: Math.round(performance.now() - openStartedAt) }; }
const openElapsedMs = Math.round(performance.now() - openStartedAt);
// Even a failed opener remains alive to report a diagnostic instead of leaving the parent waiting for IPC.
process.once('message', () => {
  let reply = failure;
  try {
    if (kernel) reply = kernel.claim({ key: 'race', requestDigest: 'same-action', owner: String(process.pid), leaseMs: 10000, evidence: {} });
  } catch (error) { reply = { kind: 'fixture_error', stage: 'claim', code: error.code ?? 'unknown', errcode: error.errcode ?? null }; }
  finally { kernel?.close(); }
  process.send(reply, () => process.disconnect());
  if (reply.kind === 'fixture_error') process.exitCode = 1;
});
process.send({ ready: true, openElapsedMs });

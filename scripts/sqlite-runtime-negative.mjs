// Opt-in regression under the affected official Node 22.16.0 binary.
// Owned synthetic fixtures only; never supply a user ledger.
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, existsSync, readFileSync, readdirSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { inspectSqliteRuntime } from '../adapters/sqlite-runtime.mjs';
import { SqliteKernel } from '../adapters/sqlite-kernel.mjs';
import { openLocalBoundary } from '../adapters/local-config.mjs';
import plugin from '../adapters/deepseek-loader-plugin.mjs';
import { fromClaudeHook } from '../dist/index.js';
import { createLedgerBackup } from '../adapters/backup.mjs';
import { applyLedgerCompaction } from '../adapters/compaction.mjs';
import { applyLedgerAuditArchive } from '../adapters/audit-archive.mjs';

assert.equal(process.versions.node, '22.16.0', 'Use the pinned affected Node only');
const runtime = inspectSqliteRuntime();
assert.equal(runtime.sqliteVersion, '3.49.1');
assert.equal(runtime.persistentWriteAllowed, false);
const root = mkdtempSync(join(tmpdir(), 'reflexmesh-old-runtime-negative-'));
const blocked = error => error?.code === 'SQLITE_WAL_RUNTIME_UNSUPPORTED';
let assertions = 0; // Number of scenario groups, not individual assert calls.
try {
  const missing = join(root, 'missing.sqlite');
  assert.throws(() => new SqliteKernel(missing), blocked);
  assert.deepEqual(readdirSync(root), []); assertions++;

  const historical = join(root, 'historical.sqlite');
  const db = new DatabaseSync(historical);
  try { db.exec("CREATE TABLE sentinel (value TEXT); INSERT INTO sentinel VALUES ('synthetic-preserved'); PRAGMA user_version=1;"); }
  finally { db.close(); }
  const bytes = readFileSync(historical);
  assert.throws(() => new SqliteKernel(historical), blocked);
  assert.deepEqual(readFileSync(historical), bytes);
  assert.deepEqual(readdirSync(root), ['historical.sqlite']); assertions++;

  const reader = new SqliteKernel(historical, { readOnly: true }); reader.close();
  assert.deepEqual(readFileSync(historical), bytes); assertions++;
  const memory = new SqliteKernel(':memory:'); memory.close(); assertions++;

  const localDir = join(root, 'local-boundary');
  assert.throws(() => openLocalBoundary({ REFLEXMESH_DB: join(localDir, 'ledger.sqlite') }), blocked);
  assert.equal(existsSync(localDir), false); assertions++;
  const pluginDir = join(root, 'loader');
  await assert.rejects(plugin.apply({}, { dbPath: join(pluginDir, 'ledger.sqlite'), tenantId: 'synthetic', scope: 'runtime' }), blocked);
  assert.equal(existsSync(pluginDir), false); assertions++;
  const archiveDir = join(root, 'blocked-backup');
  await assert.rejects(createLedgerBackup({ dbPath: historical, outDir: archiveDir }), blocked);
  assert.equal(existsSync(archiveDir), false); assertions++;
  const compactionDir = join(root, 'blocked-compaction');
  await assert.rejects(applyLedgerCompaction({ dbPath: historical, backupDirectory: archiveDir,
    planDirectory: compactionDir, quiescent: true }), blocked);
  assert.equal(existsSync(compactionDir), false); assert.deepEqual(readFileSync(historical), bytes); assertions++;
  const archivalDir = join(root, 'blocked-archival');
  await assert.rejects(applyLedgerAuditArchive({ dbPath: historical, backupDirectory: archiveDir,
    planDirectory: archivalDir, quiescent: true }), blocked);
  assert.equal(existsSync(archivalDir), false); assert.deepEqual(readFileSync(historical), bytes); assertions++;

  const run = (entry, args = [], extra = {}) => spawnSync(process.execPath,
    [fileURLToPath(new URL(`../adapters/${entry}`, import.meta.url)), ...args],
    { encoding: 'utf8', timeout: 10_000, ...extra });
  const cli = run('runtime-cli.mjs', ['--json']);
  assert.equal(cli.status, 1); assert.deepEqual(JSON.parse(cli.stdout), runtime); assertions++;
  for (const name of ['doctor-cli.mjs', 'claude-doctor-cli.mjs']) {
    const result = run(name, ['--json']);
    assert.equal(result.status, 1);
    assert.deepEqual(JSON.parse(result.stdout).prerequisites.sqliteRuntime, runtime);
    assert.ok(JSON.parse(result.stdout).diagnostics.some(item => item.code === 'sqlite_wal_runtime_unsupported'));
    assertions++;
  }
  for (const name of ['claude-hook.mjs', 'claude-task-hook.mjs']) {
    const hookDir = join(root, name);
    const payload = { hook_event_name: 'PreToolUse', session_id: 'synthetic-runtime',
      tool_use_id: 'read-1', tool_name: 'Read', tool_input: { file_path: 'synthetic.txt' } };
    assert.equal(fromClaudeHook(payload).phase, 'before');
    const result = run(name, [], { input: JSON.stringify(payload),
      env: { ...process.env, REFLEXMESH_PROVIDER: 'abstain', REFLEXMESH_INTENT_MODE: 'off',
        REFLEXMESH_DB: join(hookDir, 'ledger.sqlite'), REFLEXMESH_TASK_EVIDENCE: 'false' } });
    assert.equal(result.status, 0); assert.deepEqual(JSON.parse(result.stdout), {});
    assert.match(result.stderr, /unavailable; host (policy|behavior) unchanged/);
    assert.equal(existsSync(hookDir), false); assertions++;
  }
  console.log(JSON.stringify({ kind: 'synthetic-old-runtime-negative', runtime, scenariosPassed: assertions,
    checksPassed: true, corruptionReproduced: false, realUserLedgerAccessed: false }));
} finally {
  const target = realpathSync(root);
  assert.equal(dirname(target), realpathSync(tmpdir()));
  assert.ok(basename(target).startsWith('reflexmesh-old-runtime-negative-'));
  rmSync(target, { recursive: true, force: true });
}

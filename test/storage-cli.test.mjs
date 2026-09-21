import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, realpathSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { SqliteKernel, digest } from '../adapters/sqlite-kernel.mjs';
import { evidenceMain, parseEvidenceOptions } from '../adapters/evidence-cli.mjs';
import { formatStorageReport } from '../adapters/storage-report.mjs';
import { main as demo } from '../examples/storage-diagnostics.mjs';

const sink = () => ({ text: '', write(text) { this.text += text; } });
function directory(t) {
  const root = realpathSync(tmpdir()), dir = mkdtempSync(join(root, 'reflexmesh-storage-cli-'));
  t.after(() => { const path = realpathSync(dir); assert.equal(dirname(path), root);
    assert.ok(basename(path).startsWith('reflexmesh-storage-cli-')); rmSync(path, { recursive: true, force: true }); });
  return dir;
}
function fixture(t) {
  const dir = directory(t), path = join(dir, '本地 ledger.sqlite'), k = new SqliteKernel(path, { clock: () => 500 });
  try {
    for (const key of ['PRIVATE_completed', 'PRIVATE_unknown', 'PRIVATE_admitted']) {
      const handle = k.claim({ key, owner: 'PRIVATE_OWNER', requestDigest: digest(key), leaseMs: 1000, evidence: { note: 'PRIVATE_BODY' } }).handle;
      if (key.endsWith('completed')) k.complete(handle, { status: 'shadow', note: 'PRIVATE_RESULT' });
      if (key.endsWith('unknown')) k.abandon(handle);
    }
    k.beginClaudeHookPairing({ key: 'PRIVATE_PAIR', callDigest: digest('call'), actionDigest: digest('action'), deploymentDigest: digest('deployment') });
  } finally { k.close(); }
  return { dir, path };
}
function content(path) {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const tables = ['packs', 'runs', 'audit', 'observations', 'labels', 'recovery_reviews', 'claude_hook_pairs'];
    return JSON.stringify({ schema: db.prepare('PRAGMA user_version').get(), rows: tables.map(table => db.prepare(`SELECT * FROM ${table}`).all()) });
  } finally { db.close(); }
}
function cli(args) {
  return spawnSync(process.execPath, [resolve('adapters/evidence-cli.mjs'), ...args], { encoding: 'utf8', timeout: 15000,
    env: { PATH: process.env.PATH, REFLEXMESH_PROVIDER: 'deepseek', REFLEXMESH_ALLOW_REMOTE: 'true', DEEPSEEK_API_KEY: 'PRIVATE_KEY' }, windowsHide: true });
}
test('storage CLI accepts only its bounded scan controls and rejects destructive-looking options', () => {
  assert.deepEqual(parseEvidenceOptions(['storage', '--db', 'fixture', '--scan-limit', '10000', '--json']),
    { command: 'storage', db: 'fixture', 'scan-limit': 10000, json: true });
  for (const tail of [['--limit', '1'], ['--after', 'x'], ['--state', 'completed'], ['--apply'], ['--vacuum'], ['--delete'],
    ['--scan-limit', '0'], ['--scan-limit', '10001'], ['--scan-limit', '1.5'], ['--scan-limit', 'NaN'],
    ['--scan-limit', '1', '--scan-limit', '2'], ['--scan-limit']])
    assert.throws(() => parseEvidenceOptions(['storage', '--db', 'fixture', ...tail]));
});
test('storage CLI uses a real read-only database, redacts body/identity and preserves every application row', async t => {
  const { path } = fixture(t), before = content(path), output = sink();
  const savedFetch = globalThis.fetch; globalThis.fetch = () => { throw new Error('Network must not run'); };
  try { await evidenceMain(['storage', '--db', path, '--json'], output); }
  finally { globalThis.fetch = savedFetch; }
  const report = JSON.parse(output.text);
  assert.equal(report.kind, 'reflexmesh-storage-report'); assert.equal(report.database.tables.runs.total, 3);
  assert.deepEqual(report.database.runStates.counts, { admitted: 1, executing: 0, completed: 1, unknown: 1 });
  assert.equal(report.database.pairStates.pairOnly, 1); assert.equal(report.retention.deletionAllowed, false);
  assert.equal(report.retention.retryAllowed, false); assert.equal(report.executionAllowed, false);
  assert.equal(output.text.includes('PRIVATE'), false); assert.equal(content(path), before);
  const live = new SqliteKernel(path, { clock: () => 500 });
  try {
    const retry = key => live.claim({ key, owner: 'different', requestDigest: digest(key), leaseMs: 1000, evidence: {} });
    assert.equal(retry('PRIVATE_completed').kind, 'replay'); assert.equal(retry('PRIVATE_unknown').kind, 'unknown');
    assert.equal(retry('PRIVATE_admitted').kind, 'busy');
  } finally { live.close(); }
});
test('spawned storage CLI reports sample truncation and meaningful next actions without provider config access', t => {
  const { path } = fixture(t), before = content(path);
  const json = cli(['storage', '--db', path, '--scan-limit', '1', '--json']); assert.equal(json.status, 0, json.stderr);
  const report = JSON.parse(json.stdout); assert.equal(report.database.tables.runs.scanned, 1);
  assert.equal(report.database.tables.runs.total, null); assert.equal(report.database.tables.runs.truncated, true);
  const human = cli(['storage', '--db', path, '--scan-limit', '1']); assert.equal(human.status, 0, human.stderr);
  assert.match(human.stdout, /TRUNCATED, total unknown/); assert.match(human.stdout, /NOT a disk-space release estimate/);
  assert.match(human.stdout, /pair-only=1/); assert.match(human.stdout, /attention\/inspect/);
  assert.equal(human.stdout.includes('PRIVATE'), false); assert.equal(content(path), before);
});
test('missing DB and directory fail without creation, paths or parser details in stderr', t => {
  const dir = directory(t), path = join(dir, 'PRIVATE_MISSING.sqlite');
  for (const target of [path, dir]) {
    const result = cli(['storage', '--db', target]); assert.equal(result.status, 1);
    assert.match(result.stderr, /existing regular database file/); assert.equal(result.stderr.includes('PRIVATE_MISSING'), false);
  }
  assert.equal(existsSync(path), false);
});
test('human metadata reports unavailable sidecars rather than invented zero bytes', async t => {
  const { path } = fixture(t), output = sink(); await evidenceMain(['storage', '--db', path, '--json'], output);
  const report = JSON.parse(output.text); report.files.entries.wal = { status: 'unavailable', logicalBytes: null };
  const human = formatStorageReport(report); assert.match(human, /wal: unavailable\n/); assert.doesNotMatch(human, /wal: unavailable, 0/);
});
test('storage demo produces inspectable synthetic reviewed-UNKNOWN and pair-only evidence without overwriting', async t => {
  const dir = directory(t), out = join(dir, 'lesson'), output = sink();
  assert.equal(await demo(['--out-dir', out], output), 0); assert.match(output.text, /SYNTHETIC storage lesson/);
  assert.match(output.text, /pair-only=1/); assert.match(output.text, /TRUNCATED, total unknown/);
  const path = join(out, 'synthetic.sqlite'), k = new SqliteKernel(path, { readOnly: true });
  try { const unknown = k.recoverySnapshot('reviewed-unknown'); assert.equal(unknown.state, 'unknown');
    assert.equal(unknown.latestReview.review.resolution, 'confirmed_not_executed'); } finally { k.close(); }
  const before = readFileSync(path); await assert.rejects(demo(['--out-dir', out], sink()));
  assert.deepEqual(readFileSync(path), before);
});
test('storage demo default is account-free and removes only its owned temporary fixture directory', async () => {
  const output = sink(); assert.equal(await demo([], output), 0); assert.match(output.text, /inspector itself never deletes/);
  const help = sink(); assert.equal(await demo(['--help'], help), 0); assert.match(help.text, /no model or tools/);
  await assert.rejects(demo(['--invalid'], sink()));
});
test('spawned direct demo handles spaces/Unicode paths and rejects split arguments without echoing them', t => {
  const dir = directory(t), out = join(dir, '合成 lesson');
  const result = spawnSync(process.execPath, ['examples/storage-diagnostics.mjs', '--out-dir', out],
    { encoding: 'utf8', timeout: 15000, windowsHide: true });
  assert.equal(result.status, 0, result.stderr); assert.equal(existsSync(join(out, 'synthetic.sqlite')), true);
  const split = spawnSync(process.execPath, ['examples/storage-diagnostics.mjs', '--out-dir', 'PRIVATE_SPLIT', 'EXTRA'],
    { encoding: 'utf8', timeout: 15000, windowsHide: true });
  assert.equal(split.status, 1); assert.match(split.stderr, /paths with spaces/); assert.equal(split.stderr.includes('PRIVATE_SPLIT'), false);
});

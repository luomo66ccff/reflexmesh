import test from 'node:test';
import assert from 'node:assert/strict';
import fs, { copyFileSync, existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, readdirSync,
  realpathSync, rmSync, statSync, truncateSync, unlinkSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { spawnSync, fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createLedgerBackup, verifyLedgerBackup } from '../adapters/backup.mjs';
import { runBackupWorker } from '../adapters/backup-process.mjs';
import { backupMain, parseBackupOptions } from '../adapters/backup-cli.mjs';
import { readBounded, sameOpenedFile, sha256, hashFile } from '../adapters/backup-files.mjs';
import { main as demo, syntheticBackupLedger, syntheticRowsDigest } from '../examples/ledger-backup.mjs';

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'reflexmesh-backup-workflow-'));
  const source = join(root, '中文 source.sqlite'), archive = join(root, '归档 archive');
  const ledger = syntheticBackupLedger(source);
  t.after(() => {
    ledger.kernel.close();
    const target = realpathSync(root);
    assert.equal(dirname(target), realpathSync(tmpdir()));
    assert.ok(basename(target).startsWith('reflexmesh-backup-workflow-'));
    rmSync(target, { recursive: true, force: true });
  });
  return { root, source, archive, ledger };
}
const capture = () => ({ text: '', write(value) { this.text += value; } });

test('actual CLI backs up committed WAL with space/Chinese paths and offline verify preserves source', async t => {
  const f = fixture(t), before = syntheticRowsDigest(f.source);
  assert.ok(statSync(`${f.source}-wal`).size > 32);
  const result = spawnSync(process.execPath, ['adapters/backup-cli.mjs', 'create', '--db', f.source,
    '--out-dir', f.archive, '--json'], { encoding: 'utf8', timeout: 15000 });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.status, 'verified_archive');
  assert.equal(report.restoreAuthorized, false); assert.equal(report.retryAllowed, false);
  assert.equal(result.stdout.includes(f.source), false);
  assert.equal(result.stdout.includes('fixture-review'), false);
  assert.equal(syntheticRowsDigest(f.source), before);
  assert.equal(syntheticRowsDigest(join(f.archive, 'ledger.sqlite')), before);
  assert.deepEqual(readdirSync(f.archive).sort(), ['COMPLETE', 'ledger.sqlite', 'manifest.json'].sort());
  const archiveBytes = readFileSync(join(f.archive, 'ledger.sqlite'));
  const verified = await verifyLedgerBackup({ directory: f.archive });
  assert.deepEqual(verified.manifest, report.manifest);
  assert.deepEqual(readFileSync(join(f.archive, 'ledger.sqlite')), archiveBytes);
  f.ledger.addNewerGuard();
  assert.notEqual(syntheticRowsDigest(f.source), before);
  assert.equal((await verifyLedgerBackup({ directory: f.archive })).sourceFreshness, 'not_attested');
});

test('existing empty output, missing parent/source, source sidecar overlap and hardlinked source are rejected', async t => {
  const f = fixture(t);
  mkdirSync(f.archive);
  await assert.rejects(createLedgerBackup({ dbPath: f.source, outDir: f.archive }));
  assert.deepEqual(readdirSync(f.archive), []);
  await assert.rejects(createLedgerBackup({ dbPath: join(f.root, 'missing.sqlite'), outDir: join(f.root, 'absent') }));
  assert.equal(existsSync(join(f.root, 'absent')), false);
  await assert.rejects(createLedgerBackup({ dbPath: f.source, outDir: join(f.root, 'missing-parent', 'new') }));
  assert.equal(existsSync(join(f.root, 'missing-parent')), false);
  await assert.rejects(createLedgerBackup({ dbPath: f.source, outDir: `${f.source}-journal` }), { code: 'source_output_overlap' });
  linkSync(f.source, join(f.root, 'hardlink.sqlite'));
  await assert.rejects(createLedgerBackup({ dbPath: f.source, outDir: join(f.root, 'hardlink-output') }), { code: 'unsafe_file' });
  assert.equal(existsSync(join(f.root, 'hardlink-output')), false);
});

test('missing completion, incomplete marker, sidecars and extra files never verify', async t => {
  const f = fixture(t); await createLedgerBackup({ dbPath: f.source, outDir: f.archive });
  const complete = readFileSync(join(f.archive, 'COMPLETE'));
  unlinkSync(join(f.archive, 'COMPLETE'));
  await assert.rejects(verifyLedgerBackup({ directory: f.archive }));
  writeFileSync(join(f.archive, 'COMPLETE'), complete);
  for (const name of ['INCOMPLETE', 'ledger.sqlite-wal', 'ledger.sqlite-shm', 'ledger.sqlite-journal', 'unexpected']) {
    writeFileSync(join(f.archive, name), 'fixture');
    await assert.rejects(verifyLedgerBackup({ directory: f.archive }));
    unlinkSync(join(f.archive, name));
  }
  assert.equal((await verifyLedgerBackup({ directory: f.archive })).status, 'verified_archive');
});

test('truncation, manifest edits and wrong COMPLETE hash fail without repair', async t => {
  const f = fixture(t); await createLedgerBackup({ dbPath: f.source, outDir: f.archive });
  const database = join(f.archive, 'ledger.sqlite'), manifest = join(f.archive, 'manifest.json'), complete = join(f.archive, 'COMPLETE');
  const dbBytes = readFileSync(database), manifestBytes = readFileSync(manifest), markerBytes = readFileSync(complete);
  truncateSync(database, 1024);
  await assert.rejects(verifyLedgerBackup({ directory: f.archive })); assert.equal(statSync(database).size, 1024);
  writeFileSync(database, dbBytes);
  writeFileSync(manifest, Buffer.concat([manifestBytes, Buffer.from('garbage')]));
  await assert.rejects(verifyLedgerBackup({ directory: f.archive }));
  writeFileSync(manifest, manifestBytes);
  writeFileSync(complete, JSON.stringify({ schemaVersion: 1, manifestSha256: '0'.repeat(64) }));
  await assert.rejects(verifyLedgerBackup({ directory: f.archive }));
  writeFileSync(complete, markerBytes);
  assert.equal((await verifyLedgerBackup({ directory: f.archive })).status, 'verified_archive');
});

test('manifest fields may be reordered but hashes are not authentication or restore permission', async t => {
  const f = fixture(t); await createLedgerBackup({ dbPath: f.source, outDir: f.archive });
  const path = join(f.archive, 'manifest.json'), manifest = JSON.parse(readFileSync(path, 'utf8'));
  manifest.summary = Object.fromEntries(Object.entries(manifest.summary).reverse());
  const text = JSON.stringify(manifest, null, 2);
  writeFileSync(path, text);
  writeFileSync(join(f.archive, 'COMPLETE'), JSON.stringify({ schemaVersion: 1, manifestSha256: sha256(text) }));
  const report = await verifyLedgerBackup({ directory: f.archive });
  assert.equal(report.authenticity, 'not_attested'); assert.equal(report.restoreAuthorized, false);
});

for (const stage of ['manifest.json', 'COMPLETE']) test(`publication failure at ${stage} retains INCOMPLETE`, async t => {
  const f = fixture(t), original = fs.openSync;
  fs.openSync = function (path, ...args) {
    if (typeof path === 'string' && path === join(f.archive, stage)) throw Object.assign(new Error('PRIVATE_FAILURE'), { code: 'EACCES' });
    return original.call(this, path, ...args);
  };
  syncBuiltinESMExports();
  try { await assert.rejects(createLedgerBackup({ dbPath: f.source, outDir: f.archive })); }
  finally { fs.openSync = original; syncBuiltinESMExports(); }
  assert.equal(existsSync(join(f.archive, 'INCOMPLETE')), true);
  await assert.rejects(verifyLedgerBackup({ directory: f.archive }), { code: 'archive_incomplete' });
  assert.ok(existsSync(join(f.archive, 'ledger.sqlite')));
});

test('last layout check happens before publication, so its I/O failure retains INCOMPLETE', async t => {
  const f = fixture(t), original = fs.readdirSync;
  fs.readdirSync = function (path, ...args) {
    if (path === f.archive) throw Object.assign(new Error('PRIVATE_LAYOUT_IO_FAILURE'), { code: 'EIO' });
    return original.call(this, path, ...args);
  };
  syncBuiltinESMExports();
  try { await assert.rejects(createLedgerBackup({ dbPath: f.source, outDir: f.archive })); }
  finally { fs.readdirSync = original; syncBuiltinESMExports(); }
  assert.equal(existsSync(join(f.archive, 'INCOMPLETE')), true);
  assert.equal(existsSync(join(f.archive, 'COMPLETE')), true);
  await assert.rejects(verifyLedgerBackup({ directory: f.archive }), { code: 'archive_incomplete' });
});

test('publication unlink is the final file operation and successful archives verify', async t => {
  const f = fixture(t), originalUnlink = fs.unlinkSync, originalReadDir = fs.readdirSync;
  let published = false;
  fs.unlinkSync = function (path, ...args) {
    const result = originalUnlink.call(this, path, ...args);
    if (path === join(f.archive, 'INCOMPLETE')) published = true;
    return result;
  };
  fs.readdirSync = function (path, ...args) {
    if (published && path === f.archive) throw new Error('Must not check after publication');
    return originalReadDir.call(this, path, ...args);
  };
  syncBuiltinESMExports();
  try { assert.equal((await createLedgerBackup({ dbPath: f.source, outDir: f.archive })).status, 'verified_archive'); }
  finally { fs.unlinkSync = originalUnlink; fs.readdirSync = originalReadDir; syncBuiltinESMExports(); }
  assert.equal(published, true);
  assert.equal((await verifyLedgerBackup({ directory: f.archive })).status, 'verified_archive');
});

test('real stalled child is killed and closed before timeout rejection', async () => {
  let child, closed = false;
  const spawnWorker = () => {
    child = fork(new URL('./fixtures/backup-stalled-worker.mjs', import.meta.url), [], {
      execArgv: [], stdio: ['ignore', 'ignore', 'ignore', 'ipc'], windowsHide: true });
    child.once('close', () => { closed = true; }); return child;
  };
  await assert.rejects(runBackupWorker({}, { timeoutMs: 150, spawnWorker }), { code: 'backup_timeout' });
  assert.equal(closed, true); assert.ok(child.exitCode !== null || child.signalCode !== null);
});

test('real child cancellation waits for closure and a crash cannot count as completion', async () => {
  const controller = new AbortController(); let closed = false;
  const spawnWorker = () => {
    const child = fork(new URL('./fixtures/backup-stalled-worker.mjs', import.meta.url), [], {
      execArgv: [], stdio: ['ignore', 'ignore', 'ignore', 'ipc'], windowsHide: true });
    child.once('close', () => { closed = true; }); setTimeout(() => controller.abort(), 120); return child;
  };
  await assert.rejects(runBackupWorker({}, { timeoutMs: 5000, spawnWorker, signal: controller.signal }), { code: 'backup_cancelled' });
  assert.equal(closed, true);
  await assert.rejects(runBackupWorker({}, { timeoutMs: 5000, spawnWorker: () => {
    return fork(new URL('./fixtures/backup-stalled-worker.mjs', import.meta.url), [], {
      execArgv: ['--eval', 'process.exit(7)'], stdio: ['ignore', 'ignore', 'ignore', 'ipc'], windowsHide: true });
  } }), { code: 'backup_verification_failed' });
});

test('pre-cancelled create and invalid options have no output; metadata reads are bounded', async t => {
  const f = fixture(t), controller = new AbortController(); controller.abort();
  await assert.rejects(createLedgerBackup({ dbPath: f.source, outDir: f.archive, signal: controller.signal }), { code: 'backup_cancelled' });
  assert.equal(existsSync(f.archive), false);
  await assert.rejects(createLedgerBackup({ dbPath: f.source, outDir: f.archive, timeoutMs: 99 }));
  assert.equal(existsSync(f.archive), false);
  const metadata = join(f.root, 'metadata'); writeFileSync(metadata, 'x'.repeat(1025));
  assert.throws(() => readBounded(metadata, 1024), { code: 'metadata_too_large' });
});

test('legacy Windows unknown path volume permits only cross-handle comparison, retaining precise bigint identity', () => {
  const path = { dev: 0n, ino: 32369622322381973n, size: 65536n, mtimeNs: 100n, ctimeNs: 200n };
  const handle = { ...path, dev: 1689772372n };
  assert.equal(sameOpenedFile(path, handle, 'win32'), true);
  assert.equal(sameOpenedFile(path, handle, 'linux'), false);
  assert.equal(sameOpenedFile({ ...path, dev: 2n }, handle, 'win32'), false);
  assert.equal(sameOpenedFile(path, { ...handle, ino: path.ino + 1n }, 'win32'), false);
  assert.equal(sameOpenedFile(path, { ...handle, size: path.size + 1n }, 'win32'), false);
  assert.equal(sameOpenedFile(path, { ...handle, ctimeNs: 201n }, 'win32'), false);
  assert.equal(sameOpenedFile({ ...path, ino: Number(path.ino) }, handle, 'win32'), false);
});

test('hashing rejects handle identity changes even when the path metadata stays stable', t => {
  const f = fixture(t), path = join(f.root, 'stable-metadata'); writeFileSync(path, 'synthetic');
  const original = fs.fstatSync; let calls = 0;
  fs.fstatSync = function (...args) {
    const stat = original.apply(this, args);
    if (++calls > 1 && typeof stat.dev === 'bigint') stat.dev += 1n;
    return stat;
  };
  syncBuiltinESMExports();
  try { assert.throws(() => hashFile(path), { code: 'archive_changed' }); }
  finally { fs.fstatSync = original; syncBuiltinESMExports(); }
});

test('hashing rejects path identity changes even when the open handle stays stable', t => {
  const f = fixture(t), path = join(f.root, 'changed-path-metadata'); writeFileSync(path, 'synthetic');
  const original = fs.lstatSync; let calls = 0;
  fs.lstatSync = function (...args) {
    const stat = original.apply(this, args);
    if (++calls > 1 && typeof stat.ino === 'bigint') stat.ino += 1n;
    return stat;
  };
  syncBuiltinESMExports();
  try { assert.throws(() => hashFile(path), { code: 'archive_changed' }); }
  finally { fs.lstatSync = original; syncBuiltinESMExports(); }
});

test('CLI help is build-free and invalid/private input is redacted', async t => {
  const f = fixture(t), isolated = join(f.root, 'unbuilt'); mkdirSync(isolated);
  for (const name of ['backup-cli.mjs', 'backup-files.mjs', 'direct-run.mjs'])
    copyFileSync(fileURLToPath(new URL(`../adapters/${name}`, import.meta.url)), join(isolated, name));
  const help = spawnSync(process.execPath, [join(isolated, 'backup-cli.mjs'), '--help'], { encoding: 'utf8' });
  assert.equal(help.status, 0); assert.match(help.stdout, /no production restore/i);
  for (const argv of [['restore', '--db', 'PRIVATE_PATH', '--json'], ['create', '--db', 'PRIVATE_PATH', '--db', 'duplicate', '--json'],
    ['verify', '--dir', 'PRIVATE_PATH', '--timeout-ms', '1e3', '--json'], ['verify', '--dir', 'PRIVATE_PATH', 'SPLIT_PRIVATE', '--json']]) {
    const output = capture(); assert.equal(await backupMain(argv, output), 2);
    assert.doesNotMatch(output.text, /PRIVATE/); assert.equal(JSON.parse(output.text).code, 'invalid_arguments');
  }
  assert.throws(() => parseBackupOptions(['verify', '--dir', f.archive, '--json', '--json']));
});

test('account-free lesson verifies full synthetic content and no-retry restoration plus stale-archive counterexample', async () => {
  const output = capture(); assert.equal(await demo([], output), 0);
  assert.match(output.text, /all seven tables/); assert.match(output.text, /COUNTEREXAMPLE/);
  assert.match(output.text, /UNKNOWN.*non-retryable/);
});

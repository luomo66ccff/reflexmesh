import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { MockProvider, toolPreflightPack } from '../dist/index.js';
import { SqliteKernel, digest } from '../adapters/sqlite-kernel.mjs';
import { DurableMesh, eventKey } from '../adapters/durable-mesh.mjs';
import { AUDIT_ARCHIVE_TABLE_SQL } from '../adapters/audit-archive-schema.mjs';
import { event, result, requestOptions } from './helpers.mjs';

const binding = { providerId: 'mock', modelId: 'fixture', revision: 'fixture-v1',
  authorizationRevision: 'auth-v1', toolsetRevision: 'tools-v1' };
function workspace(t) {
  const root = realpathSync(tmpdir());
  const directory = mkdtempSync(join(root, 'reflexmesh-pack-template-'));
  t.after(() => {
    const target = realpathSync(directory);
    assert.equal(dirname(target), root);
    assert.ok(target.includes('reflexmesh-pack-template-'));
    rmSync(target, { recursive: true, force: false });
  });
  return { db: join(directory, '证据 ledger.sqlite'), out: join(directory, 'candidate pack.json') };
}
async function fixture(t) {
  const files = workspace(t), kernel = new SqliteKernel(files.db);
  const mesh = new DurableMesh({ kernel, provider: new MockProvider(result), binding })
    .registerPack(toolPreflightPack);
  const item = event();
  const decision = await mesh.run(item, requestOptions());
  assert.equal(decision.verdict.effect, 'allow');
  kernel.close();
  return { ...files, key: eventKey(item) };
}
function cli(...args) {
  return spawnSync(process.execPath, [resolve('adapters/evidence-cli.mjs'), ...args],
    { encoding: 'utf8', timeout: 10000, env: { PATH: process.env.PATH,
      REFLEXMESH_PROVIDER: 'jev', REFLEXMESH_ALLOW_REMOTE: 'true', TYPESAFE_API_KEY: 'PRIVATE_KEY' } });
}
const exportArgs = f => ['pack-template', '--db', f.db, '--key', f.key, '--out', f.out];

test('bound source pack exports to a new private file and replays without changing the ledger', async t => {
  const f = await fixture(t), before = readFileSync(f.db);
  const response = cli(...exportArgs(f), '--json');
  assert.equal(response.status, 0, response.stderr);
  const receipt = JSON.parse(response.stdout);
  assert.deepEqual(Object.keys(receipt).sort(),
    ['kind', 'sourceKey', 'sourcePackDigest', 'outputPath', 'bytesWritten', 'executionAllowed'].sort());
  assert.equal(receipt.kind, 'policy_pack_template');
  assert.equal(receipt.sourceKey, f.key);
  assert.equal(receipt.sourcePackDigest, digest(toolPreflightPack));
  assert.equal(receipt.outputPath, resolve(f.out));
  assert.equal(receipt.executionAllowed, false);
  assert.deepEqual(JSON.parse(readFileSync(f.out, 'utf8')), toolPreflightPack);
  assert.equal(statSync(f.out).size, receipt.bytesWritten);
  if (process.platform !== 'win32') assert.equal(statSync(f.out).mode & 0o077, 0);
  assert.ok(!response.stdout.includes(toolPreflightPack.questions.intentMatch.instructions));
  assert.ok(!response.stdout.includes('PRIVATE_KEY'));
  const replay = cli('replay', '--db', f.db, '--key', f.key, '--candidate-pack', f.out, '--json');
  assert.equal(replay.status, 0, replay.stderr);
  assert.equal(JSON.parse(replay.stdout).candidate.effect, 'allow');
  assert.deepEqual(readFileSync(f.db), before);
});

test('existing output is not overwritten and missing destination parent never creates a file', async t => {
  const f = await fixture(t);
  assert.equal(cli(...exportArgs(f)).status, 0);
  const before = readFileSync(f.out);
  const again = cli(...exportArgs(f));
  assert.equal(again.status, 1);
  assert.match(again.stderr, /Destination already exists/);
  assert.deepEqual(readFileSync(f.out), before);
  const missing = join(dirname(f.db), 'absent-parent', 'candidate.json');
  const unavailable = cli('pack-template', '--db', f.db, '--key', f.key, '--out', missing);
  assert.equal(unavailable.status, 1);
  assert.equal(existsSync(missing), false);
  assert.ok(!unavailable.stderr.includes('PRIVATE_KEY'));
});

test('unknown, UNKNOWN and invalid predictions do not publish a template', async t => {
  const f = await fixture(t);
  assert.match(cli('pack-template', '--db', f.db, '--key', 'not-found', '--out', f.out).stderr,
    /Unknown evidence key/);
  assert.equal(existsSync(f.out), false);
  const db = new DatabaseSync(f.db);
  try {
    db.prepare('UPDATE runs SET state=? WHERE key=?').run('unknown', f.key);
    assert.match(cli(...exportArgs(f)).stderr, /Completed prediction required/);
    assert.equal(existsSync(f.out), false);
    db.prepare('UPDATE runs SET state=?,result=? WHERE key=?').run('completed',
      JSON.stringify({ verdict: { effect: 'allow', ruleId: 'test' } }), f.key);
    assert.match(cli(...exportArgs(f)).stderr, /Bound pack or recorded prediction is invalid/);
    assert.equal(existsSync(f.out), false);
  } finally { db.close(); }
});

test('tampered pack binding, body and digest fail before output without echoing contents', async t => {
  const f = await fixture(t);
  const db = new DatabaseSync(f.db);
  try {
    const originalResult = db.prepare('SELECT result FROM runs WHERE key=?').get(f.key).result;
    const wrongModel = JSON.parse(originalResult);
    wrongModel.provider.model = 'PRIVATE_WRONG_MODEL';
    db.prepare('UPDATE runs SET result=? WHERE key=?').run(JSON.stringify(wrongModel), f.key);
    const mismatch = cli(...exportArgs(f));
    assert.match(mismatch.stderr, /Recorded provider binding mismatch/);
    assert.ok(!mismatch.stderr.includes('PRIVATE_WRONG_MODEL'));
    assert.equal(existsSync(f.out), false);
    db.prepare('UPDATE runs SET result=? WHERE key=?').run(originalResult, f.key);
    const original = db.prepare('SELECT evidence FROM runs WHERE key=?').get(f.key).evidence;
    for (const change of [e => { e.pack.digest = '0'.repeat(64); },
      e => { e.pack.questionsDigest = '1'.repeat(64); },
      e => { e.eventType = 'PRIVATE_WRONG_EVENT'; }]) {
      const evidence = JSON.parse(original); change(evidence);
      db.prepare('UPDATE runs SET evidence=? WHERE key=?').run(JSON.stringify(evidence), f.key);
      const response = cli(...exportArgs(f));
      assert.equal(response.status, 1);
      assert.equal(response.stdout, '');
      assert.equal(existsSync(f.out), false);
      assert.ok(!response.stderr.includes('PRIVATE_'));
    }
    db.prepare('UPDATE runs SET evidence=? WHERE key=?').run(original, f.key);
    const originalPack = db.prepare('SELECT digest,body FROM packs').get();
    db.prepare('UPDATE packs SET digest=?').run('2'.repeat(64));
    assert.match(cli(...exportArgs(f)).stderr, /Bound pack digest mismatch/);
    assert.equal(existsSync(f.out), false);
    db.prepare('UPDATE packs SET digest=?').run(originalPack.digest);
    db.prepare('UPDATE packs SET body=?').run('{"secret":"PRIVATE_PACK_BODY"');
    const malformed = cli(...exportArgs(f));
    assert.equal(malformed.status, 1);
    assert.equal(existsSync(f.out), false);
    assert.ok(!malformed.stderr.includes('PRIVATE_PACK_BODY'));
    db.prepare('UPDATE packs SET body=?').run('x'.repeat(128 * 1024 + 1));
    assert.match(cli(...exportArgs(f)).stderr, /too large/);
    assert.equal(existsSync(f.out), false);
  } finally { db.close(); }
});

test('schema-1 pack export reads without migration', async t => {
  const f = await fixture(t), source = new DatabaseSync(f.db, { readOnly: true });
  const run = source.prepare('SELECT key,state,evidence,result FROM runs WHERE key=?').get(f.key);
  const pack = source.prepare('SELECT id,version,digest,body FROM packs').get();
  source.close();
  const legacy = join(dirname(f.db), 'legacy.sqlite'), db = new DatabaseSync(legacy);
  db.exec('CREATE TABLE packs(id TEXT,version TEXT,digest TEXT,body TEXT);'
    + 'CREATE TABLE runs(key TEXT,state TEXT,evidence TEXT,result TEXT); PRAGMA user_version=1');
  db.prepare('INSERT INTO packs VALUES(?,?,?,?)').run(pack.id, pack.version, pack.digest, pack.body);
  db.prepare('INSERT INTO runs VALUES(?,?,?,?)').run(run.key, run.state, run.evidence, run.result);
  db.close();
  const before = readFileSync(legacy);
  const response = cli('pack-template', '--db', legacy, '--key', f.key, '--out', f.out, '--json');
  assert.equal(response.status, 0, response.stderr);
  assert.equal(JSON.parse(response.stdout).sourcePackDigest, digest(toolPreflightPack));
  assert.deepEqual(readFileSync(legacy), before);
  const read = new DatabaseSync(legacy, { readOnly: true });
  try { assert.equal(read.prepare('PRAGMA user_version').get().user_version, 1); }
  finally { read.close(); }
});

test('schema-4 metadata gate is checked without a ledger write', async t => {
  const f = await fixture(t), db = new DatabaseSync(f.db);
  db.exec(`${AUDIT_ARCHIVE_TABLE_SQL.audit_archive_batches};
    ${AUDIT_ARCHIVE_TABLE_SQL.audit_archive_coverage}; PRAGMA user_version=4`);
  db.close();
  const before = readFileSync(f.db);
  const response = cli(...exportArgs(f));
  assert.equal(response.status, 0, response.stderr);
  assert.deepEqual(readFileSync(f.db), before);
  assert.deepEqual(JSON.parse(readFileSync(f.out, 'utf8')), toolPreflightPack);
});

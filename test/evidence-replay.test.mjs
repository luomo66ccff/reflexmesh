import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { MockProvider, toolPreflightPack } from '../dist/index.js';
import { SqliteKernel } from '../adapters/sqlite-kernel.mjs';
import { DurableMesh, eventKey } from '../adapters/durable-mesh.mjs';
import { event, result, requestOptions } from './helpers.mjs';

const binding = { providerId: 'mock', modelId: 'fixture', revision: 'fixture-v1',
  authorizationRevision: 'auth-v1', toolsetRevision: 'tools-v1' };
function workspace(t) {
  const root = mkdtempSync(join(tmpdir(), 'reflexmesh replay '));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const folder = join(root, 'path with spaces');
  mkdirSync(folder);
  return { db: join(folder, 'ledger with spaces.sqlite'), candidate: join(folder, 'candidate pack.json') };
}
async function fixture(t) {
  const files = workspace(t), kernel = new SqliteKernel(files.db);
  const mesh = new DurableMesh({ kernel, provider: new MockProvider(result), binding }).registerPack(toolPreflightPack);
  const e = event();
  const decision = await mesh.run(e, requestOptions());
  assert.equal(decision.verdict.effect, 'allow');
  kernel.close();
  const candidate = structuredClone(toolPreflightPack);
  candidate.version = 'hypothetical-v1';
  candidate.rules.find(rule => rule.id === 'intent-supported').all.find(c => c.answer === 'intentMatch').value = 1;
  writeFileSync(files.candidate, JSON.stringify(candidate));
  return { ...files, key: eventKey(e), candidatePack: candidate };
}
function cli(...args) {
  return spawnSync(process.execPath, [resolve('adapters/evidence-cli.mjs'), 'replay', ...args],
    { encoding: 'utf8', timeout: 10000, env: { PATH: process.env.PATH,
      REFLEXMESH_PROVIDER: 'jev', REFLEXMESH_ALLOW_REMOTE: 'true', TYPESAFE_API_KEY: 'PRIVATE_KEY' } });
}
const args = f => ['--db', f.db, '--key', f.key, '--candidate-pack', f.candidate];

test('policy-only replay gives a narrow hypothetical receipt and keeps ledger bytes unchanged', async t => {
  const f = await fixture(t);
  const before = readFileSync(f.db);
  const json = cli(...args(f), '--json');
  assert.equal(json.status, 0, json.stderr);
  const receipt = JSON.parse(json.stdout);
  assert.deepEqual(Object.keys(receipt).sort(),
    ['candidate','candidatePackDigest','executionAllowed','hypothetical','original',
      'originalSourceConsistency','policyChanges'].sort());
  assert.equal(receipt.originalSourceConsistency, 'verified');
  assert.deepEqual(receipt.policyChanges, { status: 'verified', rulesAdded: 0,
    rulesRemoved: 0, rulesModified: 1, sharedRuleOrderChanged: false,
    fallbackChanged: false, structureUnchanged: false });
  assert.deepEqual(receipt.original, { effect: 'allow', ruleId: 'intent-supported' });
  assert.deepEqual(receipt.candidate, { effect: 'escalate', ruleId: 'fallback' });
  assert.equal(receipt.hypothetical, true);
  assert.equal(receipt.executionAllowed, false);
  assert.match(receipt.candidatePackDigest, /^[a-f0-9]{64}$/);
  const human = cli(...args(f));
  assert.equal(human.status, 0, human.stderr);
  assert.match(human.stdout, /allow -> escalate/);
  assert.match(human.stdout, /Original source consistency: verified/);
  assert.match(human.stdout, /Policy changes: 1 modified rule/);
  assert.match(human.stdout, /hypothetical: true/);
  assert.match(human.stdout, /execution allowed: false/);
  assert.deepEqual(readFileSync(f.db), before);
  assert.ok(!json.stdout.includes('PRIVATE_KEY'));
});

test('replay distinguishes a version-only pack from structural policy edits', async t => {
  const f = await fixture(t);
  const versionOnly = structuredClone(toolPreflightPack);
  versionOnly.version = 'new-name-same-policy';
  versionOnly.rules[0].note = 'PRIVATE_IGNORED_RULE_EXTRA';
  versionOnly.rules[0].all[0].note = 'PRIVATE_IGNORED_CONDITION_EXTRA';
  writeFileSync(f.candidate, JSON.stringify(versionOnly));
  const versionResponse = cli(...args(f), '--json');
  assert.equal(versionResponse.status, 0, versionResponse.stderr);
  assert.ok(!versionResponse.stdout.includes('PRIVATE_IGNORED'));
  const noChange = JSON.parse(versionResponse.stdout);
  assert.deepEqual(noChange.policyChanges, { status: 'verified', rulesAdded: 0,
    rulesRemoved: 0, rulesModified: 0, sharedRuleOrderChanged: false,
    fallbackChanged: false, structureUnchanged: true });

  const edited = structuredClone(f.candidatePack);
  edited.rules = [
    { id: 'new-no-op', all: [{ answer: 'injection', metric: 'value', op: 'gte', value: 1 }], effect: 'deny' },
    edited.rules[2], edited.rules[0],
  ];
  edited.fallback = 'deny';
  writeFileSync(f.candidate, JSON.stringify(edited));
  const response = cli(...args(f), '--json');
  assert.equal(response.status, 0, response.stderr);
  assert.deepEqual(JSON.parse(response.stdout).policyChanges, { status: 'verified',
    rulesAdded: 1, rulesRemoved: 1, rulesModified: 1, sharedRuleOrderChanged: true,
    fallbackChanged: true, structureUnchanged: false });
});

test('same effect with changed directive remains visible in both output modes', async t => {
  const f = workspace(t), original = structuredClone(toolPreflightPack);
  original.version = 'directive-original';
  original.rules.find(rule => rule.id === 'intent-supported').directive = 'original-route';
  const kernel = new SqliteKernel(f.db);
  const mesh = new DurableMesh({ kernel, provider: new MockProvider(result), binding }).registerPack(original);
  const e = event();
  assert.equal((await mesh.run(e, requestOptions())).verdict.directive, 'original-route');
  kernel.close();
  const candidate = structuredClone(original);
  candidate.version = 'directive-candidate';
  candidate.rules.find(rule => rule.id === 'intent-supported').directive = 'candidate-route';
  writeFileSync(f.candidate, JSON.stringify(candidate));
  const options = ['--db', f.db, '--key', eventKey(e), '--candidate-pack', f.candidate];
  const json = cli(...options, '--json');
  assert.equal(json.status, 0, json.stderr);
  const receipt = JSON.parse(json.stdout);
  assert.deepEqual(receipt.original, { effect: 'allow', ruleId: 'intent-supported', directive: 'original-route' });
  assert.deepEqual(receipt.candidate, { effect: 'allow', ruleId: 'intent-supported', directive: 'candidate-route' });
  const human = cli(...options);
  assert.equal(human.status, 0, human.stderr);
  assert.match(human.stdout, /original-route/);
  assert.match(human.stdout, /candidate-route/);
});

test('receipt omits stored prediction extras, task/action data, labels and candidate prose', async t => {
  const f = await fixture(t), db = new DatabaseSync(f.db);
  try {
    const row = db.prepare('SELECT evidence,result FROM runs WHERE key=?').get(f.key);
    const evidence = JSON.parse(row.evidence), storedResult = JSON.parse(row.result);
    evidence.taskEvidence = { summary: 'PRIVATE_TASK' };
    evidence.actionProse = 'PRIVATE_ACTION';
    storedResult.provider.privateMemo = 'PRIVATE_PREDICTION';
    db.prepare('UPDATE runs SET evidence=?,result=? WHERE key=?')
      .run(JSON.stringify(evidence), JSON.stringify(storedResult), f.key);
    db.prepare('INSERT INTO labels(run_key,id,body) VALUES(?,?,?)')
      .run(f.key, 'private-label', JSON.stringify({ note: 'PRIVATE_LABEL' }));
  } finally { db.close(); }
  writeFileSync(f.candidate, JSON.stringify({ ...f.candidatePack, note: 'PRIVATE_CANDIDATE_PROSE' }));
  for (const extra of [[], ['--json']]) {
    const response = cli(...args(f), ...extra);
    assert.equal(response.status, 0, response.stderr);
    for (const secret of ['PRIVATE_TASK','PRIVATE_ACTION','PRIVATE_PREDICTION','PRIVATE_LABEL','PRIVATE_CANDIDATE_PROSE'])
      assert.ok(!response.stdout.includes(secret));
    assert.ok(!response.stdout.includes(toolPreflightPack.questions.intentMatch.instructions));
  }
});

test('wrong question contract and event type fail without exposing candidate contents', async t => {
  const f = await fixture(t);
  for (const change of [candidate => { candidate.questions.intentMatch.instructions = 'PRIVATE_INSTRUCTION'; },
    candidate => { candidate.eventType = 'PRIVATE_EVENT'; }]) {
    const candidate = structuredClone(f.candidatePack);
    change(candidate);
    writeFileSync(f.candidate, JSON.stringify(candidate));
    const response = cli(...args(f), '--json');
    assert.equal(response.status, 1);
    assert.equal(response.stdout, '');
    assert.match(response.stderr, /contract mismatch/);
    assert.ok(!response.stderr.includes('PRIVATE_'));
  }
});

test('unknown, incomplete and invalid stored predictions are rejected', async t => {
  const f = await fixture(t);
  assert.match(cli('--db', f.db, '--key', 'missing', '--candidate-pack', f.candidate).stderr, /Unknown evidence key/);
  const db = new DatabaseSync(f.db);
  try {
    db.prepare('UPDATE runs SET state=? WHERE key=?').run('unknown', f.key);
    assert.match(cli(...args(f)).stderr, /Completed prediction required/);
    db.prepare('UPDATE runs SET state=?,result=? WHERE key=?').run('completed',
      JSON.stringify({ verdict: { effect: 'allow', ruleId: 'test' } }), f.key);
    assert.match(cli(...args(f)).stderr, /Bound pack or recorded prediction is invalid/);
    db.prepare('UPDATE runs SET result=? WHERE key=?').run(JSON.stringify({
      verdict: { effect: 'allow', ruleId: 'test' }, provider: { model: 'fixture', answers: {} } }), f.key);
    assert.match(cli(...args(f)).stderr, /Bound pack or recorded prediction is invalid/);
  } finally { db.close(); }
});

test('model drift in the stored prediction is not accepted as a bound replay', async t => {
  const f = await fixture(t), db = new DatabaseSync(f.db);
  try {
    const row = JSON.parse(db.prepare('SELECT result FROM runs WHERE key=?').get(f.key).result);
    row.provider.model = 'PRIVATE_OTHER_MODEL';
    db.prepare('UPDATE runs SET result=? WHERE key=?').run(JSON.stringify(row), f.key);
  } finally { db.close(); }
  const response = cli(...args(f), '--json');
  assert.equal(response.status, 1);
  assert.equal(response.stdout, '');
  assert.ok(!response.stderr.includes('PRIVATE_OTHER_MODEL'));
});

test('replay refuses inconsistent original verdict and damaged bound source pack', async t => {
  const f = await fixture(t), db = new DatabaseSync(f.db);
  try {
    const originalResult = db.prepare('SELECT result FROM runs WHERE key=?').get(f.key).result;
    const changed = JSON.parse(originalResult);
    changed.verdict = { effect: 'deny', ruleId: 'PRIVATE_FALSE_RULE' };
    db.prepare('UPDATE runs SET result=? WHERE key=?').run(JSON.stringify(changed), f.key);
    const verdictResponse = cli(...args(f), '--json');
    assert.equal(verdictResponse.status, 1);
    assert.equal(verdictResponse.stdout, '');
    assert.ok(!verdictResponse.stderr.includes('PRIVATE_FALSE_RULE'));
    db.prepare('UPDATE runs SET result=? WHERE key=?').run(originalResult, f.key);
    const originalBody = db.prepare('SELECT body FROM packs').get().body;
    db.prepare('UPDATE packs SET body=?').run('{"private":"PRIVATE_PACK_BODY"');
    const packResponse = cli(...args(f), '--json');
    assert.equal(packResponse.status, 1);
    assert.equal(packResponse.stdout, '');
    assert.ok(!packResponse.stderr.includes('PRIVATE_PACK_BODY'));
    db.prepare('UPDATE packs SET body=?').run(originalBody);
  } finally { db.close(); }
});

test('candidate input is a bounded regular JSON file and errors do not echo payloads', async t => {
  const f = await fixture(t);
  for (const body of ['', '{ "secret": "PRIVATE_PARSE_PAYLOAD",', ' '.repeat(128 * 1024 + 1)]) {
    writeFileSync(f.candidate, body);
    const response = cli(...args(f));
    assert.equal(response.status, 1);
    assert.equal(response.stdout, '');
    assert.ok(!response.stderr.includes('PRIVATE_PARSE_PAYLOAD'));
  }
  const response = cli('--db', f.db, '--key', f.key, '--candidate-pack', join(f.db, 'not-a-file'));
  assert.equal(response.status, 1);
  assert.equal(response.stdout, '');
});

test('stored evidence and result are byte-bounded before JSON parse', async t => {
  const f = await fixture(t);
  const db = new DatabaseSync(f.db);
  try {
    for (const column of ['evidence', 'result']) {
      const original = db.prepare(`SELECT ${column} AS body FROM runs WHERE key=?`).get(f.key).body;
      db.prepare(`UPDATE runs SET ${column}=? WHERE key=?`).run('PRIVATE_STORED_PAYLOAD' + 'x'.repeat(1024 * 1024), f.key);
      const response = cli(...args(f));
      assert.equal(response.status, 1);
      assert.match(response.stderr, /size limit/);
      assert.ok(!response.stderr.includes('PRIVATE_STORED_PAYLOAD'));
      db.prepare(`UPDATE runs SET ${column}=? WHERE key=?`).run(original, f.key);
    }
  } finally { db.close(); }
});

test('schema-1 read-only replay works without migrating or reading other tables', async t => {
  const f = await fixture(t);
  const source = new DatabaseSync(f.db, { readOnly: true });
  const row = source.prepare('SELECT key,state,evidence,result FROM runs WHERE key=?').get(f.key);
  source.close();
  const oldDb = join(dirname(f.db), 'legacy.sqlite');
  const db = new DatabaseSync(oldDb);
  db.exec('CREATE TABLE runs(key TEXT PRIMARY KEY,state TEXT,evidence TEXT,result TEXT); PRAGMA user_version=1');
  db.prepare('INSERT INTO runs VALUES(?,?,?,?)').run(row.key, row.state, row.evidence, row.result);
  db.close();
  const before = readFileSync(oldDb);
  const response = cli('--db', oldDb, '--key', f.key, '--candidate-pack', f.candidate, '--json');
  assert.equal(response.status, 0, response.stderr);
  assert.equal(JSON.parse(response.stdout).candidate.effect, 'escalate');
  assert.equal(JSON.parse(response.stdout).originalSourceConsistency, 'legacy_unverified');
  assert.deepEqual(JSON.parse(response.stdout).policyChanges, { status: 'legacy_unverified' });
  const human = cli('--db', oldDb, '--key', f.key, '--candidate-pack', f.candidate);
  assert.equal(human.status, 0, human.stderr);
  assert.match(human.stdout, /Original source consistency: legacy_unverified/);
  assert.deepEqual(readFileSync(oldDb), before);
  const upgradedMarker = new DatabaseSync(oldDb);
  upgradedMarker.exec('PRAGMA user_version=3');
  upgradedMarker.close();
  const damagedCurrent = cli('--db', oldDb, '--key', f.key, '--candidate-pack', f.candidate);
  assert.equal(damagedCurrent.status, 1);
  assert.match(damagedCurrent.stderr, /Bound source pack is unavailable for replay/);
});

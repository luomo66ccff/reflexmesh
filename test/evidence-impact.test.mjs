import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { MockProvider, toolPreflightPack } from '../dist/index.js';
import { SqliteKernel } from '../adapters/sqlite-kernel.mjs';
import { DurableMesh, eventKey } from '../adapters/durable-mesh.mjs';
import { event, requestOptions } from './helpers.mjs';

const binding = { providerId: 'mock', modelId: 'fixture', revision: 'fixture-v1',
  authorizationRevision: 'auth-v1', toolsetRevision: 'tools-v1' };
const cli = (db, key, candidate, ...extra) => spawnSync(process.execPath,
  [resolve('adapters/evidence-cli.mjs'), 'impact', '--db', db, '--key', key,
    '--candidate-pack', candidate, ...extra],
  { encoding: 'utf8', timeout: 15000, env: { PATH: process.env.PATH,
    REFLEXMESH_PROVIDER: 'jev', TYPESAFE_API_KEY: 'PRIVATE_KEY' } });

async function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'reflexmesh-impact-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const db = join(dir, 'ledger.sqlite'), candidate = join(dir, 'candidate.json');
  const provider = new MockProvider(state => ({ model: 'fixture', answers: {
    intentMatch: { type: 'noul', noul: state.untrustedState.score },
    injection: { type: 'noul', noul: 0 },
  } }));
  const kernel = new SqliteKernel(db);
  const mesh = new DurableMesh({ kernel, provider, binding }).registerPack(toolPreflightPack);
  const keys = [];
  for (const score of [0.20, 0.89, 0.90, 0.92, 0.95, 0.99, 0.99, 0.99]) {
    const e = event({ state: { score, secret: 'PRIVATE_STATE' } });
    await mesh.run(e, requestOptions());
    keys.push(eventKey(e));
  }
  kernel.close();
  const sql = new DatabaseSync(db);
  try {
    sql.prepare("UPDATE runs SET state='admitted',result=NULL WHERE key=?").run(keys[6]);
    sql.prepare("UPDATE runs SET state='unknown',result=NULL WHERE key=?").run(keys[7]);
  } finally { sql.close(); }
  const pack = structuredClone(toolPreflightPack);
  pack.version = 'what-if-0.95';
  pack.rules.find(rule => rule.id === 'intent-supported').all
    .find(condition => condition.answer === 'intentMatch').value = 0.95;
  writeFileSync(candidate, JSON.stringify(pack));
  return { db, candidate, keys, anchor: keys[0] };
}

test('impact reports bounded same-binding transitions and honest exclusions', async t => {
  const f = await fixture(t);
  const response = cli(f.db, f.anchor, f.candidate, '--json');
  assert.equal(response.status, 0, response.stderr);
  const report = JSON.parse(response.stdout);
  assert.equal(report.hypothetical, true);
  assert.equal(report.executionAllowed, false);
  assert.equal(report.coverage.scanned, 8);
  assert.equal(report.coverage.matched, 8);
  assert.equal(report.coverage.replayed, 6);
  assert.equal(report.coverage.excluded.incomplete, 1);
  assert.equal(report.coverage.excluded.unknown, 1);
  assert.equal(report.coverage.completeLedgerSnapshot, true);
  assert.equal(report.transitions.allow.escalate, 2);
  assert.equal(report.effectChanged, 2);
  assert.equal(report.verdictChanged, 2);
  assert.equal(report.changed.length, 2);
  assert.ok(report.changed.every(item => f.keys.includes(item.key)));
  assert.ok(!response.stdout.includes('PRIVATE_STATE'));
  assert.ok(!response.stdout.includes('PRIVATE_KEY'));
  assert.ok(!response.stdout.includes(toolPreflightPack.questions.intentMatch.instructions));
  const human = cli(f.db, f.anchor, f.candidate);
  assert.equal(human.status, 0, human.stderr);
  assert.match(human.stdout, /allow -> escalate: 2/);
  assert.match(human.stdout, /replayed: 6\/8/);
});

test('impact distinguishes a partial key-order page from complete history', async t => {
  const f = await fixture(t);
  const response = cli(f.db, f.anchor, f.candidate, '--scan-limit', '3', '--json');
  assert.equal(response.status, 0, response.stderr);
  const report = JSON.parse(response.stdout);
  assert.equal(report.coverage.scanned, 3);
  assert.equal(report.coverage.hasMore, true);
  assert.equal(report.coverage.completeLedgerSnapshot, false);
  assert.ok(f.keys.includes(report.coverage.nextCursor));
  const next = cli(f.db, f.anchor, f.candidate, '--scan-limit', '3',
    '--after', report.coverage.nextCursor, '--json');
  assert.equal(next.status, 0, next.stderr);
  assert.equal(JSON.parse(next.stdout).coverage.completeLedgerSnapshot, false);
});

test('impact fails closed on a corrupt matching verdict and mismatched candidate', async t => {
  const f = await fixture(t), sql = new DatabaseSync(f.db);
  try {
    const key = f.keys[1], row = JSON.parse(sql.prepare('SELECT result FROM runs WHERE key=?').get(key).result);
    row.verdict = { effect: 'deny', ruleId: 'PRIVATE_FALSE_RULE' };
    sql.prepare('UPDATE runs SET result=? WHERE key=?').run(JSON.stringify(row), key);
  } finally { sql.close(); }
  const response = cli(f.db, f.anchor, f.candidate, '--json');
  assert.equal(response.status, 1);
  assert.equal(response.stdout, '');
  assert.ok(!response.stderr.includes('PRIVATE_FALSE_RULE'));
  const wrong = structuredClone(toolPreflightPack);
  wrong.questions.intentMatch.instructions = 'PRIVATE_WRONG_QUESTION';
  writeFileSync(f.candidate, JSON.stringify(wrong));
  const second = cli(f.db, f.anchor, f.candidate, '--scan-limit', '1');
  assert.equal(second.status, 1);
  assert.equal(second.stdout, '');
  assert.ok(!second.stderr.includes('PRIVATE_WRONG_QUESTION'));
});

test('impact does not mix another tenant, source, mode or binding into coverage', async t => {
  const f = await fixture(t), sql = new DatabaseSync(f.db);
  try {
    const template = sql.prepare('SELECT * FROM runs WHERE key=?').get(f.keys[0]);
    const variants = [
      evidence => { evidence.tenantId = 'other'; },
      evidence => { evidence.source = 'other'; },
      evidence => { evidence.mode = 'other'; },
      evidence => { evidence.binding.revision = 'other'; },
      evidence => { evidence.pack.digest = 'a'.repeat(64); },
    ];
    for (let i = 0; i < variants.length; i++) {
      const evidence = JSON.parse(template.evidence);
      variants[i](evidence);
      sql.prepare(`INSERT INTO runs(key,request_digest,state,owner,epoch,lease_until,evidence,result)
        VALUES(?,?,?,?,?,?,?,?)`).run(`out-of-scope-${i}`, template.request_digest,
        template.state, template.owner, template.epoch, template.lease_until,
        JSON.stringify(evidence), template.result);
    }
  } finally { sql.close(); }
  const response = cli(f.db, f.anchor, f.candidate, '--json');
  assert.equal(response.status, 0, response.stderr);
  const report = JSON.parse(response.stdout);
  assert.equal(report.coverage.scanned, 13);
  assert.equal(report.coverage.matched, 8);
  assert.equal(report.coverage.excluded.outOfScope, 5);
  assert.equal(report.coverage.replayed, 6);
});

test('impact counts same-effect directive changes separately from effect changes', async t => {
  const f = await fixture(t);
  const pack = structuredClone(toolPreflightPack);
  pack.version = 'what-if-directive';
  pack.rules.find(rule => rule.id === 'intent-supported').directive = 'new-route';
  writeFileSync(f.candidate, JSON.stringify(pack));
  const response = cli(f.db, f.anchor, f.candidate, '--json');
  assert.equal(response.status, 0, response.stderr);
  const report = JSON.parse(response.stdout);
  assert.equal(report.effectChanged, 0);
  assert.equal(report.verdictChanged, 4);
  assert.equal(report.transitions.allow.allow, 4);
  assert.equal(report.changed.length, 4);
});

test('unreadable evidence prevents a complete-scope claim', async t => {
  const f = await fixture(t), sql = new DatabaseSync(f.db);
  try {
    sql.prepare('UPDATE runs SET evidence=? WHERE key=?')
      .run('PRIVATE_OVERSIZED' + 'x'.repeat(1024 * 1024), f.keys[7]);
  } finally { sql.close(); }
  const response = cli(f.db, f.anchor, f.candidate, '--json');
  assert.equal(response.status, 0, response.stderr);
  const report = JSON.parse(response.stdout);
  assert.equal(report.coverage.excluded.unreadableEvidence, 1);
  assert.equal(report.coverage.fullyClassified, false);
  assert.equal(report.coverage.completeLedgerSnapshot, false);
  assert.ok(!response.stdout.includes('PRIVATE_OVERSIZED'));
});

test('completed decision without a provider prediction is excluded, not replayed', async t => {
  const f = await fixture(t), sql = new DatabaseSync(f.db);
  try {
    const key = f.keys[5], result = JSON.parse(sql.prepare('SELECT result FROM runs WHERE key=?').get(key).result);
    delete result.provider;
    result.verdict = { effect: 'escalate', ruleId: 'provider_unavailable_or_invalid' };
    sql.prepare('UPDATE runs SET result=? WHERE key=?').run(JSON.stringify(result), key);
  } finally { sql.close(); }
  const response = cli(f.db, f.anchor, f.candidate, '--json');
  assert.equal(response.status, 0, response.stderr);
  const report = JSON.parse(response.stdout);
  assert.equal(report.coverage.matched, 8);
  assert.equal(report.coverage.replayed, 5);
  assert.equal(report.coverage.excluded.noPrediction, 1);
});

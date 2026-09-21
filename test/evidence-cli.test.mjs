import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, access } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { MockProvider, toolPreflightPack } from '../dist/index.js';
import { SqliteKernel, digest } from '../adapters/sqlite-kernel.mjs';
import { TaskAwareBoundary } from '../adapters/task-boundary.mjs';
import { parseEvidenceOptions, formatEvidence } from '../adapters/evidence-cli.mjs';
import { result } from './helpers.mjs';

const dirs = new Set();
after(async () => { for (const dir of dirs) await rm(dir, { recursive: true, force: true }); });
async function databasePath() { const dir = await mkdtemp(join(tmpdir(), 'reflexmesh-evidence-')); dirs.add(dir); return join(dir, 'ledger.sqlite'); }
const call = { schemaVersion: 1, harness: 'deepseek-harness', sessionId: 's1', agentId: 'a1', callId: 'c1', toolName: 'read', arguments: { path: 'PRIVATE_PATH_NOT_SHOWN' } };
const binding = { providerId: 'mock', modelId: 'fixture', revision: 'fixture-v1', authorizationRevision: 'auth-v1', toolsetRevision: 'tools-v1' };
const intent = { schemaVersion: 1, id: 'task-v1', scope: { harness: call.harness, sessionId: call.sessionId, agentId: call.agentId },
  source: 'host-declared', summary: 'PRIVATE_SUMMARY_NOT_SHOWN', issuedAt: 1000, expiresAt: 2000 };
function fixture(t, path = ':memory:') {
  let calls = 0;
  const kernel = new SqliteKernel(path, { clock: () => 1500 });
  t.after(() => kernel.close());
  const boundary = new TaskAwareBoundary({ kernel, clock: () => 1500, provider: new MockProvider(() => { calls++; return result(); }), binding,
    pack: toolPreflightPack, tenantId: 'test', scope: 'evidence-cli' });
  return { kernel, boundary, calls: () => calls };
}
function cli(args) {
  return spawnSync(process.execPath, ['adapters/evidence-cli.mjs', ...args], { encoding: 'utf8', timeout: 5000,
    env: { PATH: process.env.PATH, REFLEXMESH_PROVIDER: 'jev', REFLEXMESH_ALLOW_REMOTE: 'true', TYPESAFE_API_KEY: 'PRIVATE_KEY_NOT_SHOWN' } });
}

test('evidence distinguishes completed shadow decisions from host outcomes without exposing selected text', async t => {
  const f = fixture(t);
  const decision = await f.boundary.before(call, intent);
  await f.boundary.before(call, intent);
  assert.equal(f.calls(), 1);
  let view = f.kernel.evidenceSnapshot(decision.decisionId);
  assert.equal(view.run.state, 'completed'); assert.equal(view.run.resultStatus, 'shadow');
  assert.equal(view.decision.effect, 'allow'); assert.equal(view.hostOutcome.status, 'missing');
  assert.equal(view.taskEvidence.recordedStatus, 'ready'); assert.equal(view.taskEvidence.coverage, 'summary-only');
  assert.equal(view.binding.providerId, 'mock'); assert.equal(view.pack.id, 'tool-preflight');
  f.boundary.after(call, 'succeeded', { output: 'PRIVATE_OUTPUT_NOT_SHOWN' });
  view = f.kernel.evidenceSnapshot(decision.decisionId);
  assert.equal(view.hostOutcome.status, 'succeeded'); assert.equal(view.hostOutcome.count, 1);
  assert.deepEqual(view.hostOutcome.byProvenance, [{ status: 'succeeded', provenance: 'harness-reported', count: 1 }]);
  assert.equal(view.labelCount, 0); assert.equal(view.recovery.executionAllowed, false);
  const text = JSON.stringify(f.kernel.listEvidence());
  for (const secret of ['PRIVATE_PATH_NOT_SHOWN','PRIVATE_SUMMARY_NOT_SHOWN','PRIVATE_OUTPUT_NOT_SHOWN']) assert.ok(!text.includes(secret));
});

test('missing task evidence explains an abstention with zero provider calls', async t => {
  const f = fixture(t), decision = await f.boundary.before(call);
  const view = f.kernel.evidenceSnapshot(decision.decisionId);
  assert.equal(f.calls(), 0); assert.equal(view.taskEvidence.recordedStatus, 'missing');
  assert.equal(view.decision.effect, 'escalate'); assert.equal(view.decision.providerResultRecorded, false);
  assert.equal(view.decision.ruleId, 'provider_unavailable_or_invalid');
  assert.match(view.decision.explanation, /Task evidence was missing/);
});

test('confirmation verdict and directive survive JSON and both human output modes', t => {
  const k = new SqliteKernel(':memory:'); t.after(() => k.close());
  const h = k.claim({ key: 'confirm', owner: 'fixture', requestDigest: digest({}), leaseMs: 30000, evidence: { mode: 'shadow' } }).handle;
  k.complete(h, { status: 'shadow', verdict: { effect: 'confirm', ruleId: 'sensitive-review', directive: 'review_privacy' } });
  const view = k.evidenceSnapshot('confirm');
  assert.equal(JSON.parse(JSON.stringify(view)).decision.effect, 'confirm'); assert.equal(view.decision.directive, 'review_privacy');
  assert.match(formatEvidence(view, 'inspect'), /Decision: confirm/);
  assert.match(formatEvidence(k.listEvidence(), 'list'), /decision: confirm/);
  assert.match(formatEvidence(view, 'inspect'), /Advisory directive: "review_privacy"/);
});

test('human list and inspection always distinguish model-reported from harness-reported outcomes', async t => {
  const f = fixture(t), decision = await f.boundary.before(call, intent);
  const observation = { id: 'outcome', status: 'succeeded', evidenceDigest: digest({}) };
  f.kernel.observe(decision.decisionId, { ...observation, provenance: 'model-reported' });
  const view = f.kernel.evidenceSnapshot(decision.decisionId);
  assert.match(formatEvidence(view, 'inspect'), /Outcome sources: model-reported:succeeded=1/);
  assert.match(formatEvidence(f.kernel.listEvidence(), 'list'), /model-reported:succeeded=1/);
  assert.ok(!formatEvidence(view, 'inspect').includes('harness-reported:succeeded'));
});

test('different reported outcomes remain conflicting and do not become truth labels', async t => {
  const f = fixture(t), decision = await f.boundary.beforeReported(call, 'Read a fixture');
  f.boundary.after(call, 'succeeded', {}, 'model-reported');
  f.kernel.observe(decision.decisionId, { id: 'second-source', status: 'failed', provenance: 'harness-reported', evidenceDigest: digest({}) });
  const view = f.kernel.evidenceSnapshot(decision.decisionId);
  assert.equal(view.hostOutcome.status, 'conflicting'); assert.equal(view.hostOutcome.count, 2);
  assert.equal(view.taskEvidence.source, 'model-reported'); assert.equal(view.taskEvidence.recordedFreshness, 'unverified');
  assert.equal(view.labelCount, 0);
});

test('bounded evidence projection omits arbitrary payloads, predictions, audit history and label contents', t => {
  const k = new SqliteKernel(':memory:'); t.after(() => k.close());
  const huge = 'PRIVATE_BULK_TEXT'.repeat(50000);
  const handle = k.claim({ key: 'bounded', owner: 'test', requestDigest: digest({}), leaseMs: 30000,
    evidence: { rawInput: huge, pack: { id: huge }, binding: { providerId: 'independent' } } }).handle;
  for (let i = 0; i < 100; i++) k.append(handle, { kind: 'fixture.audit', details: { text: huge.slice(0, 5000) } });
  k.complete(handle, { status: 'shadow', verdict: { effect: 'escalate', ruleId: 'fixture' }, provider: { model: 'fixture', answers: { raw: huge } } });
  k.inspect = () => { throw new Error('Unbounded inspector must not be used'); };
  const view = k.evidenceSnapshot('bounded'), text = JSON.stringify(view);
  assert.equal(view.pack.id, null); assert.equal(view.binding.providerId, 'independent');
  assert.ok(text.length < 4000); assert.ok(!text.includes('PRIVATE_BULK_TEXT')); assert.equal(view.labelCount, 0);
});

test('keyset pagination is stable, bounded and state-filtered without changing admissions', t => {
  const k = new SqliteKernel(':memory:'); t.after(() => k.close());
  for (const key of ['case-c','case-a','case-b']) {
    const handle = k.claim({ key, owner: 'test', requestDigest: digest(key), leaseMs: 30000, evidence: {} }).handle;
    if (key === 'case-b') k.abandon(handle);
  }
  const first = k.listEvidence({ limit: 2 }), second = k.listEvidence({ limit: 2, after: first.nextCursor });
  assert.deepEqual(first.items.map(v => v.key), ['case-a','case-b']);
  assert.deepEqual(second.items.map(v => v.key), ['case-c']); assert.equal(second.nextCursor, null);
  assert.deepEqual(k.listEvidence({ state: 'unknown' }).items.map(v => v.key), ['case-b']);
  assert.equal(k.evidenceSnapshot('not-there'), null);
  for (const options of [{ limit: 0 }, { limit: 101 }, { limit: 1.5 }, { after: 'x'.repeat(1025) }, { state: 'allow' }]) assert.throws(() => k.listEvidence(options), /Invalid evidence/);
  assert.equal(k.recoverySnapshot('case-a').state, 'admitted');
});

test('expired execution and operator conclusions never imply retry permission', t => {
  let now = 0; const k = new SqliteKernel(':memory:', { clock: () => now }); t.after(() => k.close());
  const inputDigest = digest({});
  const handle = k.claim({ key: 'crash', owner: 'test', requestDigest: inputDigest, leaseMs: 100, evidence: { mode: 'active' } }).handle;
  k.append(handle, { kind: 'action.started', details: {} }); now = 101;
  assert.equal(k.evidenceSnapshot('crash').recovery.required, true);
  assert.equal(k.recoverySnapshot('crash').state, 'executing'); // Read-only inspection does not settle the tombstone.
  k.reviewRecovery({ schemaVersion: 1, id: 'review', runKey: 'crash', expectedEpoch: 1, inputDigest,
    resolution: 'confirmed_not_executed', evidenceDigest: digest({ fixture: true }), evidenceRef: 'fixture:test', actorRef: 'operator:test', reason: 'Fixture review', quiescent: true });
  const view = k.evidenceSnapshot('crash');
  assert.equal(view.run.state, 'unknown'); assert.equal(view.recovery.resolution, 'confirmed_not_executed');
  assert.equal(view.recovery.required, true); assert.equal(view.recovery.executionAllowed, false);
});

test('real CLI shows human explanations and JSON metadata without touching host/provider configuration', async t => {
  const path = await databasePath(), f = fixture(t, path);
  const decision = await f.boundary.before(call, intent);
  f.boundary.after(call, 'succeeded', { synthetic: true });
  const before = f.kernel.inspect(decision.decisionId);
  const human = cli(['inspect','--db',path,'--key',decision.decisionId]);
  assert.equal(human.status, 0, human.stderr); assert.match(human.stdout, /Host outcome: succeeded/); assert.match(human.stdout, /Shadow observation does not grant/);
  const json = cli(['list','--db',path,'--json']); assert.equal(json.status, 0, json.stderr);
  assert.equal(JSON.parse(json.stdout).items[0].key, decision.decisionId);
  assert.ok(!human.stdout.includes('PRIVATE_')); assert.ok(!json.stdout.includes('PRIVATE_'));
  assert.deepEqual(f.kernel.inspect(decision.decisionId), before); assert.equal(f.calls(), 1);
});

test('CLI does not create a missing database and rejects invalid arguments without echoing inputs', async () => {
  const path = await databasePath();
  const missing = cli(['list','--db',path,'--json']); assert.equal(missing.status, 1); assert.equal(missing.stdout, '');
  await assert.rejects(access(path), { code: 'ENOENT' });
  for (const args of [['list','--db','x','--apply'], ['list','--db','x','--db','y'], ['list','--db','x','--limit','0'], ['inspect','--db','x'], ['list','--db',':memory:']]) assert.throws(() => parseEvidenceOptions(args));
  const invalid = cli(['list','--PRIVATE_SECRET']); assert.equal(invalid.status, 1); assert.ok(!invalid.stderr.includes('PRIVATE_SECRET'));
  assert.match(cli(['--help']).stdout, /read-only/);
});

test('schema-1 inspection remains read-only and never creates recovery tables or migrates versions', async () => {
  const path = await databasePath(), k = new SqliteKernel(path);
  const handle = k.claim({ key: 'legacy', owner: 'test', requestDigest: digest({}), leaseMs: 100, evidence: {} }).handle;
  k.abandon(handle); k.close();
  const raw = new DatabaseSync(path);
  raw.exec('DROP TABLE recovery_reviews; PRAGMA user_version=1;'); raw.close();
  const read = cli(['inspect','--db',path,'--key','legacy','--json']);
  assert.equal(read.status, 0, read.stderr); assert.equal(JSON.parse(read.stdout).recovery.resolution, null);
  const check = new DatabaseSync(path, { readOnly: true });
  try {
    assert.equal(check.prepare('PRAGMA user_version').get().user_version, 1);
    assert.equal(check.prepare("SELECT count(*) AS n FROM sqlite_schema WHERE name='recovery_reviews'").get().n, 0);
    assert.equal(check.prepare('SELECT state FROM runs').get().state, 'unknown');
  } finally { check.close(); }
});

test('credential-free walkthrough explains the full task/decision/outcome journey without exposing fixture text', () => {
  const demo = spawnSync(process.execPath, ['examples/task-intent.mjs','--explain'], { encoding: 'utf8', timeout: 5000 });
  assert.equal(demo.status, 0, demo.stderr);
  assert.match(demo.stdout, /SYNTHETIC classification and outcomes/);
  assert.match(demo.stdout, /Host outcome: missing/); assert.match(demo.stdout, /Host outcome: succeeded/);
  assert.match(demo.stdout, /task is cleared/); assert.match(demo.stdout, /Fixture provider calls: 1; duplicate replayed: true; labels created: 0/);
  assert.ok(!demo.stdout.includes('PRIVATE_PROMPT_BODY_NOT_SELECTED'));
  assert.ok(!demo.stdout.includes('Read README without editing files'));
});

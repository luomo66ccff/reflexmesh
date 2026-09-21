import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, rmSync, existsSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { SqliteKernel, digest } from '../adapters/sqlite-kernel.mjs';
import { formatEvidence, parseEvidenceOptions } from '../adapters/evidence-cli.mjs';

const prefix = 'reflexmesh-attention-test-';
function fixture(t, clock = () => 100) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  const path = join(dir, 'ledger.sqlite');
  const kernels = new Set();
  t.after(() => {
    for (const kernel of kernels) kernel.close();
    const target = realpathSync(dir), parent = realpathSync(tmpdir());
    assert.equal(dirname(target).toLowerCase(), parent.toLowerCase());
    assert.ok(basename(target).startsWith(prefix));
    rmSync(target, { recursive: true, force: true });
  });
  return {
    path,
    open(options = {}) { const kernel = new SqliteKernel(path, { clock, ...options }); kernels.add(kernel); return kernel; },
    close(kernel) { kernel.close(); kernels.delete(kernel); },
  };
}
function claim(kernel, key, { mode = 'shadow', leaseMs = 100 } = {}) {
  return kernel.claim({ key, owner: 'fixture', requestDigest: digest(key), leaseMs,
    evidence: { mode, rawInput: 'PRIVATE_INPUT_NOT_SHOWN'.repeat(100) } }).handle;
}
function finish(kernel, key, options = {}) {
  const handle = claim(kernel, key, options);
  kernel.complete(handle, { status: options.mode === 'active' ? 'succeeded' : 'shadow',
    verdict: { effect: 'escalate', ruleId: 'fixture' }, output: 'PRIVATE_OUTPUT_NOT_SHOWN' });
}
function observe(kernel, key, status, id = status) {
  kernel.observe(key, { id, status, provenance: 'harness-reported', evidenceDigest: digest('PRIVATE_OUTPUT_NOT_SHOWN') });
}
function reasons(page, key) {
  return page.items.find(item => item.key === key)?.attention.reasons.map(reason => reason.code);
}
function cli(args) {
  return spawnSync(process.execPath, ['adapters/evidence-cli.mjs', ...args], {
    encoding: 'utf8', timeout: 5000,
    env: { PATH: process.env.PATH, REFLEXMESH_PROVIDER: 'jev', REFLEXMESH_ALLOW_REMOTE: 'true',
      TYPESAFE_API_KEY: 'PRIVATE_CREDENTIAL_NOT_SHOWN' },
  });
}

test('attention distinguishes decision, report and pairing conditions without calling tools', t => {
  let now = 100;
  const f = fixture(t, () => now), k = f.open();
  finish(k, 'a-shadow-missing');
  finish(k, 'b-active-missing', { mode: 'active' });
  claim(k, 'c-admitted');
  const expired = claim(k, 'd-expired', { mode: 'active' });
  k.append(expired, { kind: 'action.started', details: {} });
  const unknown = claim(k, 'e-unknown', { mode: 'active' });
  k.abandon(unknown);
  finish(k, 'f-reported-unknown'); observe(k, 'f-reported-unknown', 'unknown');
  finish(k, 'g-conflict'); observe(k, 'g-conflict', 'succeeded'); observe(k, 'g-conflict', 'failed');
  finish(k, 'h-succeeded'); observe(k, 'h-succeeded', 'succeeded');
  finish(k, 'i-failed'); observe(k, 'i-failed', 'failed');
  const pending = { key: 'j-pair-pending', callDigest: digest('call'), actionDigest: digest('action'),
    deploymentDigest: digest('deployment') };
  k.beginClaudeHookPairing(pending);
  finish(k, pending.key, { mode: 'active' }); observe(k, pending.key, 'succeeded');
  const blocked = { ...pending, key: 'k-pair-blocked' };
  const receipt = k.beginClaudeHookPairing(blocked);
  k.blockClaudeHookPairing(receipt);
  finish(k, blocked.key, { mode: 'active' }); observe(k, blocked.key, 'succeeded');
  k.beginClaudeHookPairing({ ...pending, key: 'z-pair-only-reservation' });
  now = 201;
  const healthy = claim(k, 'l-healthy-executing', { mode: 'active' });
  k.append(healthy, { kind: 'action.started', details: {} });
  const both = { ...pending, key: 'm-pair-and-unknown' };
  const bothReceipt = k.beginClaudeHookPairing(both);
  k.blockClaudeHookPairing(bothReceipt);
  finish(k, both.key, { mode: 'active' }); observe(k, both.key, 'unknown');
  const page = k.listAttention({ limit: 100 });
  assert.deepEqual(page.items.map(item => item.key), ['a-shadow-missing', 'd-expired', 'e-unknown',
    'f-reported-unknown', 'g-conflict', 'j-pair-pending', 'k-pair-blocked', 'm-pair-and-unknown']);
  for (const [key, code] of [['a-shadow-missing','shadow_outcome_missing'], ['d-expired','execution_lease_expired'],
    ['e-unknown','execution_unknown'], ['f-reported-unknown','reported_unknown'], ['g-conflict','outcome_conflict'],
    ['j-pair-pending','hook_pairing_pending'], ['k-pair-blocked','hook_pairing_blocked']]) {
    assert.deepEqual(reasons(page, key), [code]);
    assert.ok(page.items.find(item => item.key === key).attention.reasons[0].explanation.length > 20);
  }
  assert.equal(page.items.find(item => item.key === 'f-reported-unknown').run.state, 'completed');
  assert.equal(page.items.find(item => item.key === 'f-reported-unknown').recovery.required, false);
  assert.equal(page.items.find(item => item.key === 'e-unknown').hostOutcome.status, 'missing');
  assert.deepEqual(reasons(page, both.key), ['reported_unknown','hook_pairing_blocked']);
  assert.deepEqual(page.coverage, { population: 'decision_rows', pairOnlyReservations: 'excluded' });
  assert.equal(page.nextCursor, null);
  assert.ok(!JSON.stringify(page).includes('PRIVATE_'));
  assert.equal(k.evidenceSnapshot('a-shadow-missing').attention, undefined);
  assert.equal(k.listEvidence().items[0].attention, undefined);
});

test('model-only unknown and mixed-source conflict retain provenance without a host claim', t => {
  const f = fixture(t), k = f.open();
  finish(k, 'a-model-unknown');
  k.observe('a-model-unknown', { id: 'model', status: 'unknown', provenance: 'model-reported',
    evidenceDigest: digest('model') });
  finish(k, 'b-mixed-conflict');
  k.observe('b-mixed-conflict', { id: 'model', status: 'succeeded', provenance: 'model-reported',
    evidenceDigest: digest('model') });
  k.observe('b-mixed-conflict', { id: 'oracle', status: 'failed', provenance: 'test-oracle',
    evidenceDigest: digest('oracle') });
  const page = k.listAttention();
  assert.deepEqual(reasons(page, 'a-model-unknown'), ['reported_unknown']);
  assert.deepEqual(reasons(page, 'b-mixed-conflict'), ['outcome_conflict']);
  assert.deepEqual(page.items[0].hostOutcome.byProvenance,
    [{ status: 'unknown', provenance: 'model-reported', count: 1 }]);
  const human = formatEvidence(page, 'attention');
  assert.match(human, /outcome observations: unknown \[model-reported:unknown=1\]/);
  assert.match(human, /test-oracle:failed=1/);
  assert.match(human, /model-reported:succeeded=1/);
  assert.doesNotMatch(human, /host report|host reports|The host reported/i);
  assert.doesNotMatch(JSON.stringify(page.items.map(item => item.attention.reasons)), /host report|host reports|The host reported/i);
});

test('filter precedes keyset limit; one clock value governs selection and projection', t => {
  let now = 100, clockCalls = 0;
  const f = fixture(t, () => { clockCalls++; return now; }), k = f.open();
  finish(k, 'a-normal', { mode: 'active' }); observe(k, 'a-normal', 'succeeded');
  finish(k, 'b-attention');
  finish(k, 'c-normal', { mode: 'active' }); observe(k, 'c-normal', 'succeeded');
  const handle = claim(k, 'd-expiring', { mode: 'active' });
  k.append(handle, { kind: 'action.started', details: {} });
  finish(k, 'e-normal', { mode: 'active' }); observe(k, 'e-normal', 'failed');
  finish(k, 'f-attention');
  now = 200;
  const before = clockCalls;
  const first = k.listAttention({ limit: 1 });
  assert.equal(clockCalls, before + 1);
  assert.deepEqual(first.items.map(item => item.key), ['b-attention']);
  assert.equal(first.nextCursor, 'b-attention');
  const second = k.listAttention({ limit: 1, after: first.nextCursor });
  assert.deepEqual(second.items.map(item => item.key), ['d-expiring']);
  assert.deepEqual(reasons(second, 'd-expiring'), ['execution_lease_expired']);
  assert.equal(second.nextCursor, 'd-expiring');
  const third = k.listAttention({ limit: 1, after: second.nextCursor });
  assert.deepEqual(third.items.map(item => item.key), ['f-attention']);
  assert.equal(third.nextCursor, null);
  assert.deepEqual(k.listAttention({ after: 'zz' }).items, []);
  for (const options of [{ limit: 0 }, { limit: 101 }, { limit: 1.2 }, { after: 'x'.repeat(1025) }])
    assert.throws(() => k.listAttention(options), /Invalid attention page/);
});

test('reviewed UNKNOWN remains attention and unrecognized legacy report is exposed only as a fixed reason', t => {
  let now = 100;
  const f = fixture(t, () => now), k = f.open();
  const handle = claim(k, 'a-reviewed', { mode: 'active' });
  k.append(handle, { kind: 'action.started', details: {} });
  finish(k, 'b-unrecognized');
  now = 201;
  k.reviewRecovery({ schemaVersion: 1, id: 'review', runKey: 'a-reviewed', expectedEpoch: 1,
    inputDigest: digest('a-reviewed'), resolution: 'confirmed_not_executed', evidenceDigest: digest('review'),
    evidenceRef: 'fixture:test', actorRef: 'operator:test', reason: 'Fixture review', quiescent: true });
  f.close(k);
  const raw = new DatabaseSync(f.path);
  try {
    raw.prepare('INSERT INTO observations VALUES(?,?,?)').run('b-unrecognized', 'legacy',
      JSON.stringify({ id: 'legacy', status: 'PRIVATE_FAKE_STATUS', provenance: 'harness-reported', evidenceDigest: digest('legacy') }));
  } finally { raw.close(); }
  const read = f.open({ readOnly: true });
  const page = read.listAttention();
  assert.deepEqual(page.items.map(item => item.key), ['a-reviewed','b-unrecognized']);
  assert.deepEqual(reasons(page, 'a-reviewed'), ['execution_unknown']);
  assert.equal(page.items[0].recovery.resolution, 'confirmed_not_executed');
  assert.equal(page.items[0].recovery.executionAllowed, false);
  assert.deepEqual(reasons(page, 'b-unrecognized'), ['outcome_unrecognized']);
  assert.equal(JSON.stringify(page).includes('PRIVATE_FAKE_STATUS'), false);
});

test('schema 1, 2 and 3 attention queries do not migrate or modify historical rows', t => {
  for (const version of [1, 2, 3]) {
    const f = fixture(t), k = f.open();
    finish(k, `legacy-${version}`);
    f.close(k);
    if (version < 3) {
      const downgrade = new DatabaseSync(f.path);
      try {
        downgrade.exec(`DROP TABLE claude_hook_pairs; ${version === 1 ? 'DROP TABLE recovery_reviews;' : ''} PRAGMA user_version=${version};`);
      } finally { downgrade.close(); }
    }
    const before = new DatabaseSync(f.path, { readOnly: true });
    let body;
    try { body = before.prepare('SELECT evidence,result FROM runs').get(); } finally { before.close(); }
    const read = f.open({ readOnly: true });
    assert.deepEqual(reasons(read.listAttention(), `legacy-${version}`), ['shadow_outcome_missing']);
    f.close(read);
    const check = new DatabaseSync(f.path, { readOnly: true });
    try {
      assert.equal(check.prepare('PRAGMA user_version').get().user_version, version);
      assert.deepEqual(check.prepare('SELECT evidence,result FROM runs').get(), body);
      assert.equal(check.prepare("SELECT count(*) AS n FROM sqlite_schema WHERE name='claude_hook_pairs'").get().n,
        version < 3 ? 0 : 1);
      assert.equal(check.prepare("SELECT count(*) AS n FROM sqlite_schema WHERE name='recovery_reviews'").get().n,
        version < 2 ? 0 : 1);
    } finally { check.close(); }
  }
});

test('public attention CLI is bounded, read-only and omits raw inputs, outputs and credentials', t => {
  const f = fixture(t), k = f.open();
  finish(k, 'needs-attention');
  const before = k.inspect('needs-attention');
  const json = cli(['attention','--db',f.path,'--limit','1','--json']);
  assert.equal(json.status, 0, json.stderr);
  const page = JSON.parse(json.stdout);
  assert.deepEqual(reasons(page, 'needs-attention'), ['shadow_outcome_missing']);
  assert.deepEqual(page.coverage, { population: 'decision_rows', pairOnlyReservations: 'excluded' });
  const human = cli(['attention','--db',f.path]);
  assert.equal(human.status, 0, human.stderr);
  assert.match(human.stdout, /shadow_outcome_missing: A completed shadow decision/);
  assert.match(human.stdout, /pair-only reservations without runs are excluded/);
  for (const secret of ['PRIVATE_INPUT_NOT_SHOWN','PRIVATE_OUTPUT_NOT_SHOWN','PRIVATE_CREDENTIAL_NOT_SHOWN']) {
    assert.ok(!json.stdout.includes(secret)); assert.ok(!human.stdout.includes(secret));
    assert.ok(!json.stderr.includes(secret)); assert.ok(!human.stderr.includes(secret));
  }
  assert.ok(json.stdout.length < 5000);
  assert.deepEqual(k.inspect('needs-attention'), before);
  assert.equal(parseEvidenceOptions(['attention','--db',f.path,'--limit','100']).limit, 100);
  for (const args of [['attention','--db',f.path,'--state','unknown'], ['attention','--db',f.path,'--key','x'],
    ['attention','--db',f.path,'--limit','0'], ['attention','--db',f.path,'--limit','101'],
    ['attention','--db',f.path,'--limit','1','--limit','2'], ['attention','--db',f.path,'--after','x'.repeat(1025)]]) {
    if (args.includes('--after')) {
      const invalid = cli(args); assert.equal(invalid.status, 1); assert.equal(invalid.stdout, '');
    } else assert.throws(() => parseEvidenceOptions(args));
  }
  const missing = join(dirname(f.path), 'missing.sqlite');
  const absent = cli(['attention','--db',missing,'--json']);
  assert.equal(absent.status, 1); assert.equal(absent.stdout, ''); assert.equal(existsSync(missing), false);
  const bad = cli(['attention','--PRIVATE_SECRET']);
  assert.equal(bad.status, 1); assert.ok(!bad.stderr.includes('PRIVATE_SECRET'));
  assert.match(formatEvidence(page, 'attention'), /never authorizes a retry/);
});

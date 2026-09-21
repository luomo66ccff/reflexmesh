import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { SqliteKernel } from '../adapters/sqlite-kernel.mjs';
import { localEnvironment } from '../scripts/claude-local-probe.mjs';

const wrapper = resolve('scripts/claude-local-hook.mjs');
function fixture(t, scenario = 'single-read') {
  const directory = mkdtempSync(join(tmpdir(), 'reflexmesh-local-hook-test-'));
  t.after(() => {
    const target = realpathSync(directory);
    assert.equal(dirname(target), realpathSync(tmpdir()));
    assert.ok(basename(target).startsWith('reflexmesh-local-hook-test-'));
    rmSync(target, { recursive: true, force: true });
  });
  const env = localEnvironment(process.env, { directory, baseUrl: 'http://127.0.0.1:1', token: 'unused-synthetic', scenario });
  writeFileSync(env.REFLEXMESH_LOCAL_FIXTURE, 'synthetic file');
  writeFileSync(env.REFLEXMESH_LOCAL_RECEIPTS, '');
  const run = (event, extra = {}) => {
    const processResult = spawnSync(process.execPath, [wrapper], { cwd: directory, env, encoding: 'utf8', timeout: 5000,
      input: JSON.stringify({ hook_event_name: event, session_id: 'synthetic-session', tool_use_id: 'synthetic-call',
        tool_name: 'Read', tool_input: { file_path: env.REFLEXMESH_LOCAL_FIXTURE }, ...extra }) });
    assert.equal(processResult.status, 0, processResult.stderr);
    assert.equal(processResult.error, undefined);
    return JSON.parse(processResult.stdout);
  };
  const receipts = () => readFileSync(env.REFLEXMESH_LOCAL_RECEIPTS, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
  const ledger = () => {
    const kernel = new SqliteKernel(env.REFLEXMESH_DB, { readOnly: true });
    try { return kernel.listEvidence().items; } finally { kernel.close(); }
  };
  return { env, run, receipts, ledger };
}

test('test hook wrapper delegates real task adapter and proves Stop cleanup at the point of delivery', t => {
  const f = fixture(t);
  for (const [event, fields] of [
    ['UserPromptSubmit', { prompt: 'ReflexMesh-Intent: Synthetic wrapper task' }],
    ['PreToolUse', {}], ['PostToolUse', { tool_response: { synthetic: 'result' } }], ['Stop', {}],
  ]) assert.deepEqual(f.run(event, fields), {});
  const receipts = f.receipts();
  assert.equal(receipts.length, 4);
  assert.ok(receipts.every(receipt => receipt.abstained && receipt.unavailable === 0));
  assert.equal(receipts.at(-1).cacheEmptyAfterStop, true);
  assert.equal(JSON.stringify(receipts).includes('Synthetic wrapper task'), false);
  const item = f.ledger()[0];
  assert.equal(item.hostOutcome.hookPairing.state, 'ready');
  assert.equal(item.hostOutcome.count, 1);
});

test('test hook duplicate injection changes observation delivery, not host tool count or permission response', t => {
  const f = fixture(t, 'duplicate-pre');
  assert.deepEqual(f.run('UserPromptSubmit', { prompt: 'ReflexMesh-Intent: Synthetic duplicate task' }), {});
  assert.deepEqual(f.run('PreToolUse'), {});
  assert.deepEqual(f.run('PostToolUse', { tool_response: {} }), {});
  const pre = f.receipts().find(receipt => receipt.event === 'PreToolUse');
  assert.equal(pre.deliveries, 2);
  assert.equal(pre.unavailable, 1);
  const item = f.ledger()[0];
  assert.deepEqual(item.hostOutcome.hookPairing, { state: 'blocked', reasonCode: 'duplicate_pre' });
  assert.equal(item.hostOutcome.count, 0);
});

test('fixture guard denies other paths before observation and prints no raw payload', t => {
  const f = fixture(t);
  const other = join(dirname(f.env.REFLEXMESH_LOCAL_FIXTURE), 'other-synthetic-file');
  writeFileSync(other, 'synthetic other content');
  const result = f.run('PreToolUse', { tool_input: { file_path: other, arbitrary: 'private-payload' } });
  assert.equal(result.hookSpecificOutput.permissionDecision, 'deny');
  assert.equal(JSON.stringify(result).includes('private-payload'), false);
  assert.deepEqual(f.receipts(), []);
  assert.equal(existsSync(f.env.REFLEXMESH_DB), false);
});

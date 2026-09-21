import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { readEvaluationJson, reserveEvaluationOutput } from '../adapters/evaluation-files.mjs';

function temporary(t) {
  const root = realpathSync(tmpdir()), path = mkdtempSync(join(root, 'reflexmesh-evaluation-files-'));
  t.after(() => { const target = realpathSync(path); assert.equal(dirname(target), root);
    assert.ok(basename(target).startsWith('reflexmesh-evaluation-files-')); rmSync(target, { recursive: true, force: true }); });
  return path;
}
test('bounded evaluation JSON reader rejects malformed UTF8, size, directory and private parser text', t => {
  const dir = temporary(t), path = join(dir, 'input.json');
  writeFileSync(path, '{"value":1}'); assert.deepEqual(readEvaluationJson(path), { value: 1 });
  assert.throws(() => readEvaluationJson(path, 1)); assert.throws(() => readEvaluationJson(dir));
  for (const content of ['PRIVATE_INVALID_JSON', Buffer.from([0xff])]) {
    writeFileSync(path, content); assert.throws(() => readEvaluationJson(path), e => !e.message.includes('PRIVATE'));
  }
});
test('output reservation refuses existing files and preserves interrupted no-retry marker', t => {
  const path = join(temporary(t), 'run.json'), output = reserveEvaluationOutput(path);
  output.close(); output.close(); const before = readFileSync(path, 'utf8');
  assert.deepEqual(JSON.parse(before), { schemaVersion: 1, kind: 'reflexmesh-evaluation-incomplete', retryAllowed: false });
  assert.throws(() => reserveEvaluationOutput(path)); assert.equal(readFileSync(path, 'utf8'), before);
  assert.throws(() => output.finish({ status: 'late' }));
});
test('reserved output finalizes once and exposes only bounded JSON', t => {
  const path = join(temporary(t), 'run.json'), output = reserveEvaluationOutput(path);
  output.finish({ status: 'complete', count: 2 }); output.close();
  assert.deepEqual(readEvaluationJson(path), { count: 2, status: 'complete' });
  assert.throws(() => output.finish({ status: 'replacement' }));
});

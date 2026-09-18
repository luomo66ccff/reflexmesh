import test from 'node:test';
import assert from 'node:assert/strict';
import { parseOptions, createArgs } from '../scripts/publish-github.mjs';
test('publication defaults to verified intended owner and private visibility', () => {
  const o = parseOptions([]); assert.equal(o.owner, 'luomo66ccff'); assert.equal(o.name, 'reflexmesh'); assert.equal(o.visibility, 'private');
});
test('public publication requires explicit flag', () => {
  assert.equal(parseOptions(['--public']).visibility, 'public'); assert.equal(parseOptions(['--dry-run']).dryRun, true);
});
test('publication rejects malformed names and unknown options', () => {
  assert.throws(() => parseOptions(['--owner', '../x'])); assert.throws(() => parseOptions(['--name'])); assert.throws(() => parseOptions(['--force']));
});
test('publication command preserves path arguments without a shell', () => {
  const args = createArgs(parseOptions([]), '/path with spaces/reflexmesh');
  assert.ok(args.includes('/path with spaces/reflexmesh')); assert.ok(args.includes('--private')); assert.ok(!args.includes('--force'));
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { STORAGE_TABLES, storageView } from '../adapters/storage-view.mjs';

const input = (version = 3, limit = 2) => ({ ledgerSchemaVersion: version, scanLimit: limit,
  pages: { pageSize: 4096, pageCount: 10, freelistCount: 2 },
  rows: Object.fromEntries(STORAGE_TABLES.map(name => [name,
    name === 'recovery_reviews' && version < 2 || name === 'claude_hook_pairs' && version < 3 ? null : []])) });

test('projection counts bounded sample, lookahead, state subsets and pair-only without exposing rows', () => {
  const raw = input();
  raw.rows.runs = [{ state: 'unknown' }, { state: 'completed' }, { state: 'admitted' }];
  raw.rows.claude_hook_pairs = [{ state: 'blocked', pairOnly: 1 }, { state: 'ready', pairOnly: 0 },
    { state: 'pending', pairOnly: 1 }];
  raw.rows.audit = [{ present: 1 }];
  const view = storageView(raw);
  assert.deepEqual(view.tables.runs, { supported: true, scanned: 2, truncated: true, total: null });
  assert.deepEqual(view.tables.audit, { supported: true, scanned: 1, truncated: false, total: 1 });
  assert.deepEqual(view.runStates.counts, { admitted: 0, executing: 0, completed: 1, unknown: 1 });
  assert.deepEqual(view.pairStates.counts, { pending: 0, ready: 1, blocked: 1 });
  assert.equal(view.pairStates.pairOnly, 1);
  assert.deepEqual(view.pages, { pageSize: 4096, pageCount: 10, freelistCount: 2,
    logicalBytes: 40960, reusableBytes: 8192 });
  assert.equal(Object.isFrozen(view.tables.runs), true);
  assert.equal(JSON.stringify(view).includes('state'), false);
});

test('schema 1/2 unavailable tables are null coverage, never zero totals', () => {
  const one = storageView(input(1));
  for (const name of ['recovery_reviews', 'claude_hook_pairs'])
    assert.deepEqual(one.tables[name], { supported: false, scanned: null, truncated: null, total: null });
  assert.deepEqual(one.pairStates, { sample: 'scanned-claude-hook-pairs', supported: false, counts: null, pairOnly: null });
  const two = storageView(input(2));
  assert.equal(two.tables.recovery_reviews.supported, true);
  assert.equal(two.tables.recovery_reviews.total, 0);
  assert.equal(two.tables.claude_hook_pairs.supported, false);
});

test('invalid page metadata, schema, state, unsupported scan and oversized sample fail closed', () => {
  const bad = change => { const raw = input(); change(raw); assert.throws(() => storageView(raw)); };
  bad(x => { x.pages.freelistCount = 11; });
  bad(x => { x.pages.pageCount = -1; });
  bad(x => { x.pages.pageSize = 1000; });
  bad(x => { x.pages.pageCount = Number.MAX_SAFE_INTEGER; });
  bad(x => { x.ledgerSchemaVersion = 4; });
  bad(x => { x.rows.runs = [{ state: 'retryable' }]; });
  bad(x => { x.rows.runs = [{ state: 'unknown', body: 'PRIVATE' }]; });
  bad(x => { x.rows.packs = [{ present: 1 }, { present: 1 }, { present: 1 }, { present: 1 }]; });
  bad(x => { x.rows.claude_hook_pairs = [{ state: 'ready', pairOnly: 2 }]; });
  const old = input(1); old.rows.recovery_reviews = [];
  assert.throws(() => storageView(old), /Unsupported storage table/);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JsonlLedger, readLedger } from '../adapters/jsonl-ledger.mjs';
test('JSONL serializes concurrent writes and preserves complete records', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'reflexmesh-'));
  try {
    const path = join(dir, 'audit.jsonl'); const ledger = new JsonlLedger(path);
    await Promise.all(Array.from({ length: 20 }, (_, i) => ledger.append({ kind: 'outcome', eventId: `e${i}`, details: {} })));
    const rows = await readLedger(path); assert.equal(rows.length, 20); assert.equal(rows[19].eventId, 'e19');
  } finally { await rm(dir, { recursive: true, force: true }); }
});
test('JSONL snapshots caller objects before queueing', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'reflexmesh-'));
  try {
    const path = join(dir, 'audit.jsonl'); const ledger = new JsonlLedger(path);
    const row = { kind: 'outcome', eventId: 'a', details: { safe: true } };
    const p = ledger.append(row); row.details.safe = false; await p;
    assert.equal(JSON.parse((await readFile(path, 'utf8')).trim()).details.safe, true);
    await writeFile(path, 'bad row\n'); await assert.rejects(readLedger(path), /row 1/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

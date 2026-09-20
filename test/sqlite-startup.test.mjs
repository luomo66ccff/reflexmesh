import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fork } from 'node:child_process';
import { configureJournal } from '../adapters/sqlite-startup.mjs';

const busy = () => Object.assign(new Error('fixture busy'), { code: 'ERR_SQLITE_ERROR', errcode: 5 });
function mockDb(read) {
  const statements = []; let attempts = 0;
  return { statements, get attempts() { return attempts; }, exec(sql) { statements.push(sql); },
    prepare(sql) { assert.equal(sql, 'PRAGMA journal_mode=WAL'); return { get() { attempts++; return read(attempts); } }; } };
}
test('journal setup retries only BUSY under the same budget and restores caller timeout', () => {
  const db = mockDb(n => { if (n === 1) throw Object.assign(busy(), { errcode: 261 }); return { journal_mode: 'wal' }; });
  configureJournal(db, { busyTimeoutMs: 100 });
  assert.equal(db.attempts, 2); assert.equal(db.statements.at(-1), 'PRAGMA busy_timeout=100');
  assert.ok(db.statements.includes('PRAGMA synchronous=FULL'));
  const budgets = db.statements.filter(s => s.startsWith('PRAGMA busy_timeout=')).slice(0,-1).map(s => Number(s.split('=')[1]));
  assert.ok(budgets[1] <= budgets[0]);
});
test('non-BUSY startup errors are never retried even if their text mentions locking', () => {
  for (const error of [Object.assign(new Error('database is locked'), { code: 'ERR_SQLITE_ERROR', errcode: 6 }),
    Object.assign(new Error('database is locked'), { code: 'ERR_SQLITE_ERROR', errcode: 10 }), new Error('database is locked')]) {
    const db = mockDb(() => { throw error; });
    assert.throws(() => configureJournal(db, { busyTimeoutMs: 100 }), e => e === error);
    assert.equal(db.attempts, 1); assert.equal(db.statements.at(-1), 'PRAGMA busy_timeout=100');
  }
});
test('zero startup contention budget performs only one attempt', () => {
  const error = busy(), db = mockDb(() => { throw error; });
  assert.throws(() => configureJournal(db, { busyTimeoutMs: 0 }), e => e === error);
  assert.equal(db.attempts, 1);
});
test('continuous BUSY exhausts a total contention budget instead of retrying indefinitely', () => {
  const error = busy(), db = mockDb(() => { throw error; }), start = performance.now();
  assert.throws(() => configureJournal(db, { busyTimeoutMs: 25 }), e => e === error);
  assert.ok(performance.now() - start < 2000); // Broad watchdog bound, not a latency benchmark.
  assert.equal(db.statements.at(-1), 'PRAGMA busy_timeout=25');
});
test('journal setup verifies WAL, permits only explicit in-memory mode, and rejects invalid budgets', () => {
  assert.throws(() => configureJournal(mockDb(() => ({ journal_mode: 'delete' })), { busyTimeoutMs: 10 }), /unavailable/);
  assert.throws(() => configureJournal(mockDb(() => ({ journal_mode: 'memory' })), { busyTimeoutMs: 10 }), /unavailable/);
  configureJournal(mockDb(() => ({ journal_mode: 'memory' })), { busyTimeoutMs: 10, inMemory: true });
  for (const budget of [-1, 1.5, 10001, NaN]) assert.throws(() => configureJournal(mockDb(() => ({})), { busyTimeoutMs: budget }), /budget/);
});

function worker(path) {
  const child = fork(new URL('./fixtures/admission-racer.mjs', import.meta.url), [path], { stdio: ['ignore','ignore','pipe','ipc'] });
  let stderr = '', ended = false, waiter;
  const queued = [];
  child.stderr.on('data', b => { stderr = (stderr + b.toString()).slice(-4096); });
  const finish = (error, message) => { const w = waiter; waiter = undefined; if (!w) return; clearTimeout(w.timer); error ? w.reject(error) : w.resolve(message); };
  child.on('message', message => waiter ? finish(null, message) : queued.push(message));
  const closed = new Promise(resolve => child.once('close', () => { ended = true; finish(new Error(`Fixture exited before reply: ${stderr}`)); resolve(); }));
  child.on('error', error => finish(error));
  return {
    async next() {
      if (queued.length) return queued.shift();
      if (ended) throw new Error(`Fixture already exited: ${stderr}`);
      assert.equal(waiter, undefined);
      return new Promise((resolve,reject) => { waiter = { resolve, reject, timer: setTimeout(() => finish(new Error(`Fixture IPC deadline: ${stderr}`)), 4000) }; });
    },
    send() { child.send('go'); },
    async stop() { if (!ended) child.kill('SIGKILL'); await closed; },
  };
}
test('repeated fresh-database startup races still yield one admission across four OS processes', { timeout: 15000 }, async () => {
  for (let round = 0; round < 8; round++) {
    const dir = await mkdtemp(join(tmpdir(), 'reflexmesh-startup-'));
    const workers = Array.from({ length: 4 }, () => worker(join(dir, 'state.sqlite')));
    try {
      const ready = await Promise.all(workers.map(w => w.next())); assert.ok(ready.every(r => r.ready === true));
      const replies = workers.map(w => w.next()); workers.forEach(w => w.send());
      const results = await Promise.all(replies);
      assert.deepEqual(results.map(r => r.kind).sort(), ['busy','busy','busy','claimed'], JSON.stringify(results));
    } finally { await Promise.all(workers.map(w => w.stop())); await rm(dir, { recursive: true, force: true }); }
  }
});

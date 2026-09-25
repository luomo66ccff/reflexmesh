import test from 'node:test';
import assert from 'node:assert/strict';
import { assertDeadlineMs, withDeadline } from '../dist/runtime/deadline.js';

const MAX_DELAY = 2_147_483_647;

test('deadline helper rejects values Node would truncate or turn into 1 ms before calling work', async () => {
  for (const value of [0, -1, 0.5, 1.5, NaN, Infinity, -Infinity,
    MAX_DELAY + 1, Number.MAX_SAFE_INTEGER, '50', null]) {
    assert.throws(() => assertDeadlineMs(value, 'deadline'), {
      name: 'ContractError', message: `Invalid deadline: expected integer milliseconds from 1 to ${MAX_DELAY}`,
    });
    let calls = 0;
    await assert.rejects(withDeadline(value, async () => { calls++; return 'unexpected'; }), {
      name: 'ContractError', message: `Invalid deadline: expected integer milliseconds from 1 to ${MAX_DELAY}`,
    });
    assert.equal(calls, 0);
  }
});

test('minimum and maximum representable deadlines allow immediate work without waiting', async () => {
  assert.doesNotThrow(() => assertDeadlineMs(1, 'deadline'));
  assert.doesNotThrow(() => assertDeadlineMs(MAX_DELAY, 'deadline'));
  assert.equal(await withDeadline(MAX_DELAY, async () => 'completed'), 'completed');
});

test('a valid short deadline still bounds work that ignores cancellation', async () => {
  await assert.rejects(withDeadline(5, () => new Promise(() => {})), /Deadline exceeded/);
});

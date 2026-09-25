import test from 'node:test';
import assert from 'node:assert/strict';
import { requireListedDeepSeekModel } from '../adapters/evaluation-model-catalog.mjs';

const catalog = (...ids) => Response.json({ object: 'list', data: ids.map(id => ({ id, object: 'model', owned_by: 'deepseek' })) });
const options = fetch => ({ apiKey: 'private-fixture-key', modelId: 'deepseek-flash', fetch });

test('listed-model preflight makes exactly one fixed, credentialed GET and exposes no key', async () => {
  let calls = 0;
  const result = await requireListedDeepSeekModel(options(async (url, request) => {
    calls++;
    assert.equal(url, 'https://api.deepseek.com/models');
    assert.equal(request.method, 'GET');
    assert.equal(request.redirect, 'error');
    assert.equal(request.body, undefined);
    assert.equal(request.headers.Authorization, 'Bearer private-fixture-key');
    return catalog('deepseek-flash', 'deepseek-v4-pro');
  }));
  assert.equal(result, true);
  assert.equal(calls, 1);
});

test('unlisted alias and malformed or unavailable catalogs fail closed without leaking bodies', async () => {
  for (const [name, fetch, pattern] of [
    ['unlisted', async () => catalog('deepseek-flash'), /not listed/],
    ['rejected', async () => new Response('PRIVATE_RESPONSE', { status: 401 }), /rejected/],
    ['network', async () => { throw new Error('PRIVATE_NETWORK'); }, /unavailable/],
    ['bad-json', async () => new Response('PRIVATE_RESPONSE', { status: 200 }), /invalid/],
    ['bad-shape', async () => Response.json({ object: 'list', data: [{ id: 'deepseek-flash' }] }), /invalid/],
    ['oversized', async () => new Response('x'.repeat(65537), { status: 200 }), /invalid or unavailable/],
  ]) {
    const modelId = name === 'unlisted' ? 'deepseek-v4-flash' : 'deepseek-flash';
    await assert.rejects(requireListedDeepSeekModel({ ...options(fetch), modelId }), error => {
      assert.match(error.message, pattern);
      assert.equal(/PRIVATE|fixture-key|x{20}/.test(error.message), false);
      return true;
    }, name);
  }
});

test('invalid key and model fail before transport', async () => {
  let calls = 0;
  const fetch = async () => { calls++; return catalog('deepseek-flash'); };
  await assert.rejects(requireListedDeepSeekModel({ apiKey: 'bad\nkey', modelId: 'deepseek-flash', fetch }), /API key/);
  await assert.rejects(requireListedDeepSeekModel({ apiKey: 'key', modelId: 'bad model', fetch }), /model required/);
  assert.equal(calls, 0);
});

test('pre-cancel and stalled catalog body stop without an evaluation request', async () => {
  let calls = 0, cancelled = false;
  const already = new AbortController(); already.abort();
  await assert.rejects(requireListedDeepSeekModel({ ...options(async () => { calls++; return catalog('deepseek-flash'); }),
    signal: already.signal }), /unavailable/);
  assert.equal(calls, 0);
  const during = new AbortController();
  const stalled = new Response(new ReadableStream({ cancel() { cancelled = true; } }), { status: 200 });
  const pending = requireListedDeepSeekModel({ ...options(async () => { calls++; return stalled; }), signal: during.signal });
  setTimeout(() => during.abort(), 5);
  await assert.rejects(pending, /invalid or unavailable/);
  assert.equal(calls, 1); assert.equal(cancelled, true);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { JevProvider } from '../dist/index.js';
const questions = { ok: { type: 'noul', instructions: 'Is it OK?' } };
const body = () => ({ model: 'fixture-pinned-model', answers: { ok: { type: 'noul', noul: 0.75 } }, usage: { input_tokens: 22, output_tokens: 0 } });
const signal = () => new AbortController().signal;
test('Jev adapter follows official endpoint/auth/body contract with injected fetch', async () => {
  let captured;
  const provider = new JevProvider({ apiKey: 'FAKE_OFFLINE_TEST_KEY', model: 'fixture-pinned-model', fetch: async (url, init) => { captured = { url, init }; return Response.json(body()); } });
  const r = await provider.evaluate({ content: 'example' }, questions, signal());
  assert.equal(captured.url, 'https://api.typesafe.ai/v1/systemone');
  assert.equal(captured.init.headers.Authorization, 'Bearer FAKE_OFFLINE_TEST_KEY');
  assert.equal(captured.init.redirect, 'error'); assert.equal(JSON.parse(captured.init.body).model, 'fixture-pinned-model');
  assert.equal(r.usage.inputTokens, 22); assert.equal(r.answers.ok.noul, 0.75);
  assert.ok(!JSON.stringify(provider).includes('FAKE_OFFLINE_TEST_KEY'));
});
test('Jev missing key/model is rejected before networking', () => {
  assert.throws(() => new JevProvider({ apiKey: '', model: 'x' }), /API key/);
  assert.throws(() => new JevProvider({ apiKey: 'fake', model: '' }), /model/);
});
test('Jev HTTP errors do not echo bodies or automatically retry', async () => {
  let calls = 0;
  const p = new JevProvider({ apiKey: 'fake', model: 'x', fetch: async () => { calls++; return new Response('PRIVATE', { status: 429 }); } });
  await assert.rejects(p.evaluate({}, questions, signal()), e => e.message === 'TypeSafe HTTP 429'); assert.equal(calls, 1);
});
test('Jev abort prevents the request', async () => {
  let calls = 0; const p = new JevProvider({ apiKey: 'fake', model: 'x', fetch: async () => { calls++; return Response.json(body()); } });
  const c = new AbortController(); c.abort(); await assert.rejects(p.evaluate({}, questions, c.signal)); assert.equal(calls, 0);
});
test('Jev invalid and oversized responses are rejected', async () => {
  const bad = new JevProvider({ apiKey: 'fake', model: 'x', fetch: async () => new Response('not JSON') });
  await assert.rejects(bad.evaluate({}, questions, signal()), /Invalid TypeSafe JSON/);
  const big = new JevProvider({ apiKey: 'fake', model: 'x', maxResponseBytes: 5, fetch: async () => Response.json(body()) });
  await assert.rejects(big.evaluate({}, questions, signal()), /too large/);
});

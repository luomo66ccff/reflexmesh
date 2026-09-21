import test from 'node:test';
import assert from 'node:assert/strict';
import { DeepSeekEstimateProvider, DEEPSEEK_ESTIMATE_CAPABILITIES } from '../dist/index.js';

const questions = { ok: { type: 'noul', instructions: 'Does the action match the explicit synthetic intent?' } };
const signal = () => new AbortController().signal;
const body = () => ({ object: 'chat.completion', model: 'synthetic-model', choices: [{ index: 0, finish_reason: 'stop',
  message: { role: 'assistant', content: JSON.stringify({ answers: { ok: { type: 'noul', noul: 0.731 } } }) } }], usage: { prompt_tokens: 23, completion_tokens: 41 } });
const provider = fetch => new DeepSeekEstimateProvider({ apiKey: 'FAKE_OFFLINE_DEEPSEEK_KEY', model: 'synthetic-model', fetch });

test('independent JSON transport keeps model-authored estimate and explicitly exposes its semantics', async () => {
  let captured;
  const p = provider(async (url, init) => { captured = { url, init }; return Response.json(body()); });
  const result = await p.evaluate({ request: 'synthetic' }, questions, signal());
  assert.equal(captured.url, 'https://api.deepseek.com/chat/completions');
  assert.equal(captured.init.headers.Authorization, 'Bearer FAKE_OFFLINE_DEEPSEEK_KEY');
  assert.equal(captured.init.redirect, 'error');
  const request = JSON.parse(captured.init.body);
  assert.equal(request.model, 'synthetic-model'); assert.equal(request.stream, false);
  assert.equal(request.max_tokens, 512); assert.deepEqual(request.thinking, { type: 'disabled' });
  assert.deepEqual(request.response_format, { type: 'json_object' });
  assert.equal(Object.hasOwn(request, 'tools'), false);
  assert.deepEqual(JSON.parse(request.messages[1].content), { state: { request: 'synthetic' }, questions });
  assert.match(request.messages[0].content, /subjective probability estimate/);
  assert.equal(result.answers.ok.noul, 0.731); assert.equal(result.answers.ok.confidence, undefined);
  assert.deepEqual(result.usage, { inputTokens: 23, outputTokens: 41 });
  assert.equal(p.capabilities.probabilitySemantics, 'elicited-estimate');
  assert.equal(p.capabilities.answers.choice, 'unsupported'); assert.equal(p.capabilities.answers.score, 'unsupported');
  assert.ok(Object.isFrozen(p)); assert.ok(Object.isFrozen(p.capabilities.limits));
  assert.equal(JSON.stringify(p).includes('FAKE_OFFLINE'), false);
});

for (const [name, change] of [
  ['missing key', { apiKey: '' }], ['header injection', { apiKey: 'a\r\nb' }], ['missing model', { model: '' }],
  ['unsafe model', { model: 'bad\nmodel' }], ['zero output budget', { maxOutputTokens: 0 }],
  ['oversized output budget', { maxOutputTokens: 4097 }], ['fractional budget', { maxOutputTokens: 1.5 }],
  ['invalid response limit', { maxResponseBytes: -1 }], ['unbounded response limit', { maxResponseBytes: 1048577 }],
  ['invalid transport', { fetch: true }],
]) test(`DeepSeek configuration refuses ${name}`, () => {
  assert.throws(() => new DeepSeekEstimateProvider({ apiKey: 'fake', model: 'synthetic-model', ...change }));
});
for (const [name, state, suppliedQuestions] of [
  ['choice', {}, { q: { type: 'choice', instructions: 'Pick', criteria: { yes: 'yes', no: 'no' } } }],
  ['score', {}, { q: { type: 'score', instructions: 'Score', criteria: ['low', 'high'] } }],
  ['UTF8 state bytes', { text: '界'.repeat(6000) }, questions],
  ['question count', {}, Object.fromEntries(Array.from({ length: 17 }, (_, i) => [`q${i}`, questions.ok]))],
  ['full wire body bytes', {}, { q: { type: 'noul', instructions: 'x'.repeat(33000) } }],
  ['non-JSON state', { invalid: Infinity }, questions],
]) test(`DeepSeek ${name} refuses before any egress`, async () => {
  let calls = 0; const p = provider(async () => { calls++; return Response.json(body()); });
  await assert.rejects(p.evaluate(state, suppliedQuestions, signal())); assert.equal(calls, 0);
});
test('pre-abort prevents egress and cancellation during a pending stream stops reading', async () => {
  let calls = 0; const pre = new AbortController(); pre.abort();
  await assert.rejects(provider(async () => { calls++; return Response.json(body()); }).evaluate({}, questions, pre.signal));
  assert.equal(calls, 0);
  let entered, cancelled = false;
  const ready = new Promise(resolve => { entered = resolve; });
  const during = new AbortController();
  const result = provider(async () => { calls++; return new Response(new ReadableStream({ start() { entered(); }, cancel() { cancelled = true; } })); }).evaluate({}, questions, during.signal);
  await ready; during.abort(); await assert.rejects(result); assert.equal(calls, 1); assert.equal(cancelled, true);
});
for (const [name, mutate] of [
  ['missing answers', b => { b.choices[0].message.content = '{}'; }],
  ['missing question', b => { b.choices[0].message.content = '{"answers":{}}'; }],
  ['label-only answer', b => { b.choices[0].message.content = '{"answers":{"ok":"yes"}}'; }],
  ['string probability', b => { b.choices[0].message.content = '{"answers":{"ok":{"type":"noul","noul":"0.9"}}}'; }],
  ['outside probability', b => { b.choices[0].message.content = '{"answers":{"ok":{"type":"noul","noul":1.1}}}'; }],
  ['extra confidence', b => { b.choices[0].message.content = '{"answers":{"ok":{"type":"noul","noul":0.9,"confidence":1}}}'; }],
  ['extra instruction', b => { b.choices[0].message.content = '{"answers":{"ok":{"type":"noul","noul":0.9}},"instruction":"PRIVATE"}'; }],
  ['wrong model', b => { b.model = 'different-model'; }],
  ['wrong object', b => { b.object = 'chat.completion.chunk'; }],
  ['missing usage', b => { delete b.usage; }],
  ['bad usage', b => { b.usage.prompt_tokens = -1; }],
  ['extra choice', b => { b.choices.push(structuredClone(b.choices[0])); }],
  ['wrong choice index', b => { b.choices[0].index = 1; }],
  ['non-assistant content', b => { b.choices[0].message.role = 'user'; }],
  ['tool call', b => { b.choices[0].message.tool_calls = [{ id: 'forbidden' }]; }],
  ['truncated completion', b => { b.choices[0].finish_reason = 'length'; }],
  ['filtered completion', b => { b.choices[0].finish_reason = 'content_filter'; }],
  ['aborted completion', b => { b.choices[0].finish_reason = 'aborted'; }],
  ['empty completion', b => { b.choices[0].message.content = ''; }],
  ['markdown wrapped answer', b => { b.choices[0].message.content = '```json\n' + b.choices[0].message.content + '\n```'; }],
]) test(`DeepSeek rejects ${name} without repair or retry`, async () => {
  let calls = 0; const value = body(); mutate(value);
  const p = provider(async () => { calls++; return Response.json(value); });
  await assert.rejects(p.evaluate({}, questions, signal()), error => !error.message.includes('PRIVATE'));
  assert.equal(calls, 1);
});
test('HTTP/network/UTF8/response limits never leak raw private content', async () => {
  for (const fetch of [async () => new Response('PRIVATE RESPONSE', { status: 429 }), async () => { throw new Error('PRIVATE TRANSPORT'); },
    async () => new Response('PRIVATE NOT JSON'), async () => new Response(new Uint8Array([0xff]))]) {
    await assert.rejects(provider(fetch).evaluate({}, questions, signal()), error => !error.message.includes('PRIVATE'));
  }
  const p = new DeepSeekEstimateProvider({ apiKey: 'fake', model: 'synthetic-model', maxResponseBytes: 5, fetch: async () => Response.json(body()) });
  await assert.rejects(p.evaluate({}, questions, signal()), /oversized/);
});
test('capability declaration is not caller-mutable', () => {
  assert.throws(() => { DEEPSEEK_ESTIMATE_CAPABILITIES.answers.choice = 'distribution-with-confidence'; });
  assert.throws(() => { DEEPSEEK_ESTIMATE_CAPABILITIES.limits.maxStateBytes = 999999; });
});

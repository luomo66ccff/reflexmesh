import assert from 'node:assert/strict';
import test from 'node:test';
import { createFailureTools } from '../scripts/claude-failure-tools.mjs';
import { startClaudeFailureFixture, matchesFailureResults, FAILURE_CALLS, FAILURE_TOOL } from '../scripts/claude-failure-server.mjs';

const options = { model: 'synthetic-model', token: 'synthetic-token', okText: 'synthetic-ok', failText: 'synthetic-fail', marker: 'synthetic-done' };
const first = () => ({ model: options.model, stream: false, tools: [{ name: FAILURE_TOOL }], messages: [{ role: 'user', content: 'synthetic task' }] });
const second = () => ({ ...first(), messages: [...first().messages, { role: 'assistant', content: structuredClone(FAILURE_CALLS) },
  { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'fixture_ok', content: [{ type: 'text', text: options.okText }] },
    { type: 'tool_result', tool_use_id: 'fixture_fail', content: options.failText, is_error: true }] }] });
const post = (server, value, path = '/v1/messages', token = options.token) => fetch(server.baseUrl + path, {
  method: 'POST', headers: { 'x-api-key': token, 'content-type': 'application/json' },
  body: typeof value === 'string' ? value : JSON.stringify(value), signal: AbortSignal.timeout(3000) });
async function fixture(t) { const server = await startClaudeFailureFixture(options); t.after(() => server.close()); return server; }

test('strict non-stream fixture serves exactly two calls and checks mixed results', async t => {
  const server = await fixture(t);
  assert.equal(new URL(server.baseUrl).hostname, '127.0.0.1');
  assert.equal((await fetch(server.baseUrl + '/api/hello', { method: 'HEAD' })).status, 204);
  const one = await post(server, first()); assert.equal(one.status, 200);
  assert.deepEqual((await one.json()).content, FAILURE_CALLS);
  const two = await post(server, second()); assert.equal(two.status, 200);
  assert.deepEqual((await two.json()).content, [{ type: 'text', text: options.marker }]);
  assert.deepEqual(server.snapshot(), { helloRequests: 1, messageRequests: 2, resultMatched: true, completed: true, boundedFailure: 'none' });
  assert.equal((await post(server, second())).status, 400);
  assert.equal(server.snapshot().completed, false);
});

test('streaming emits two independent tool blocks then a final marker', async t => {
  const server = await fixture(t), request = { ...first(), stream: true };
  const response = await post(server, request);
  assert.match(response.headers.get('content-type'), /text\/event-stream/);
  const events = (await response.text()).trim().split('\n\n').map(event => JSON.parse(event.split('\n')[1].slice(6)));
  const starts = events.filter(item => item.type === 'content_block_start');
  assert.deepEqual(starts.map(item => item.content_block.id), ['fixture_ok', 'fixture_fail']);
  const deltas = events.filter(item => item.type === 'content_block_delta');
  assert.deepEqual(deltas.map(item => JSON.parse(item.delta.partial_json)), [{ mode: 'ok' }, { mode: 'fail' }]);
  const final = await post(server, { ...second(), stream: true });
  assert.ok((await final.text()).includes(options.marker));
});

for (const [name, mutate] of [
  ['wrong result ID', r => { r.messages[2].content[1].tool_use_id = 'wrong'; }],
  ['failure reported as success', r => { r.messages[2].content[1].is_error = false; }],
  ['success reported as failure', r => { r.messages[2].content[0].is_error = true; }],
  ['swapped arguments', r => { r.messages[1].content[0].input.mode = 'fail'; }],
  ['extra argument', r => { r.messages[1].content[0].input.extra = true; }],
  ['foreign tool name', r => { r.messages[1].content[0].name = 'Bash'; }],
  ['extra result', r => { r.messages[2].content.push({ ...r.messages[2].content[0] }); }],
  ['metadata-only proof', r => { r.messages[2].content[0].content = { proof: options.okText }; }],
  ['tool-use block in user role', r => { r.messages[1].role = 'user'; }],
  ['tool-result block in assistant role', r => { r.messages[2].role = 'assistant'; }],
  ['results preceding calls', r => { [r.messages[1], r.messages[2]] = [r.messages[2], r.messages[1]]; }],
]) test(`${name} rejects the exchange without retry recovery`, async t => {
  const server = await fixture(t); await post(server, first());
  const input = second(); mutate(input);
  assert.equal(matchesFailureResults(input.messages, options), false);
  const response = await post(server, input); assert.equal(response.status, 400);
  assert.equal((await post(server, second())).status, 400);
  assert.equal(server.snapshot().completed, false);
  assert.equal(server.snapshot().boundedFailure, 'result_mismatch');
});

for (const [name, request, path, token] of [
  ['invalid JSON', '{private-bad-json'],
  ['wrong model', { ...first(), model: 'private-model' }],
  ['extra tool', { ...first(), tools: [...first().tools, { name: 'Bash' }] }],
  ['history before admission', second()],
  ['nonboolean stream', { ...first(), stream: 'yes' }],
  ['unauthorized', first(), '/v1/messages', 'private-wrong-token'],
  ['unknown route', first(), '/v1/models'],
  ['unknown query', first(), '/v1/messages?unknown=1'],
]) test(`initial ${name} is bounded and redacted`, async t => {
  const server = await fixture(t), response = await post(server, request, path, token);
  assert.equal(response.status, 400);
  const body = await response.text(); assert.equal(body.includes('private'), false);
  assert.equal((await post(server, first())).status, 400);
  assert.equal(server.snapshot().completed, false);
});

test('oversized request and excessive requests are rejected', async t => {
  const server = await fixture(t);
  assert.equal((await post(server, 'x'.repeat(1024 * 1024 + 1))).status, 400);
  assert.equal(server.snapshot().boundedFailure, 'body_limit');
  for (let index = 0; index < 8; index++) assert.equal((await post(server, first())).status, 400);
  assert.equal(server.snapshot().completed, false);
  await server.close(); await server.close();
  await assert.rejects(fetch(server.baseUrl, { signal: AbortSignal.timeout(500) }));
});

const rpc = (id, method, params) => ({ jsonrpc: '2.0', id, method, params });
const call = (mode, id = mode) => rpc(id, 'tools/call', { name: 'outcome', arguments: { mode } });
test('MCP tool bodies share an explicit overlap barrier and return different statuses', async t => {
  const receipts = [], fixture = createFailureTools({ record: r => receipts.push(r), ...options });
  t.after(() => fixture.close());
  const listed = await fixture.handle(rpc(1, 'tools/list', {}));
  assert.equal(listed.result.tools.length, 1);
  assert.equal(listed.result.tools[0].annotations.readOnlyHint, true);
  const ok = fixture.handle(call('ok')), fail = fixture.handle(call('fail'));
  assert.deepEqual(receipts, [{ event: 'entered', mode: 'ok', active: 1 }, { event: 'entered', mode: 'fail', active: 2 }]);
  const values = await Promise.all([ok, fail]);
  assert.equal(values[0].result.isError, false); assert.equal(values[1].result.isError, true);
  assert.deepEqual(receipts.slice(2).map(r => [r.event, r.active, r.overlapping]), [['exited', 1, true], ['exited', 0, true]]);
  await assert.rejects(fixture.handle(call('ok')), /invalid_call/);
  await assert.rejects(fixture.handle(call('other')), /invalid_call/);
});

test('MCP one-body timeout and explicit closure cannot claim overlap', async () => {
  for (const closeEarly of [false, true]) {
    const receipts = [], fixture = createFailureTools({ record: r => receipts.push(r), ...options, timeoutMs: 10 });
    const pending = fixture.handle(call('ok')); if (closeEarly) fixture.close();
    const reply = await pending; assert.equal(reply.result.isError, true);
    assert.equal(receipts[1].overlapping, false);
    await assert.rejects(fixture.handle(call('fail')), /invalid_call/); fixture.close();
  }
});

test('MCP unknown methods, extra arguments and bad notifications are rejected', async t => {
  const fixture = createFailureTools({ record() {}, ...options }); t.after(() => fixture.close());
  for (const request of [{}, rpc(1, 'files/write', {}), { ...call('ok'), params: { name: 'outcome', arguments: { mode: 'ok', extra: true } } },
    { jsonrpc: '2.0', method: 'notifications/unknown' }]) await assert.rejects(fixture.handle(request));
  assert.equal(await fixture.handle({ jsonrpc: '2.0', method: 'notifications/initialized' }), undefined);
});

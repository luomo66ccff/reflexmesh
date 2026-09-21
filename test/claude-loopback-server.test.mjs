import assert from 'node:assert/strict';
import test from 'node:test';
import { createConnection } from 'node:net';
import { once } from 'node:events';
import { request } from 'node:http';
import { startClaudeFixture } from '../scripts/claude-loopback-server.mjs';

const options = { model: 'synthetic-claude-test', fixturePath: '/synthetic/read-only.txt',
  fixtureText: 'REFLEXMESH_SYNTHETIC_FIXTURE_TEXT', token: 'fixture-secret-token',
  marker: 'REFLEXMESH_SYNTHETIC_DONE' };
const first = (stream = false) => ({ model: options.model, max_tokens: 64, stream,
  tools: [{ name: 'Read', input_schema: { type: 'object', properties: { file_path: { type: 'string' } } } }],
  messages: [{ role: 'user', content: 'Read the fixture' }] });
const second = (stream = false, block = {}) => ({ ...first(stream), messages: [
  { role: 'user', content: 'Read the fixture' },
  { role: 'assistant', content: [{ type: 'tool_use', id: 'reflexmesh_fixture_read', name: 'Read',
    input: { file_path: options.fixturePath } }] },
  { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'reflexmesh_fixture_read',
    content: [{ type: 'text', text: options.fixtureText }], ...block }] },
] });
async function fixture(t) {
  const server = await startClaudeFixture(options);
  t.after(() => server.close());
  return server;
}
function post(server, payload, { path = '/v1/messages', token = options.token, method = 'POST' } = {}) {
  return fetch(new URL(path, server.baseUrl), { method,
    headers: { 'content-type': 'application/json', 'x-api-key': token },
    ...(method === 'POST' ? { body: typeof payload === 'string' ? payload : JSON.stringify(payload) } : {}),
    signal: AbortSignal.timeout(3000),
  });
}
async function sse(response) {
  assert.match(response.headers.get('content-type'), /^text\/event-stream/);
  const raw = await response.text();
  return raw.trim().split('\n\n').map(chunk => {
    const [event, data] = chunk.split('\n');
    assert.match(event, /^event: /);
    assert.match(data, /^data: /);
    const value = JSON.parse(data.slice(6));
    assert.equal(value.type, event.slice(7));
    return value;
  });
}

test('non-stream Messages returns one Read call, accepts its result, then ends with fixed marker', async t => {
  const server = await fixture(t);
  assert.equal(new URL(server.baseUrl).hostname, '127.0.0.1');
  const tokens = await post(server, { model: options.model, messages: [] }, { path: '/v1/messages/count_tokens?beta=true' });
  assert.equal(tokens.status, 200);
  assert.deepEqual(await tokens.json(), { input_tokens: 1 });
  const read = await post(server, first(), { path: '/v1/messages?beta=true' });
  assert.equal(read.status, 200);
  const call = await read.json();
  assert.equal(call.type, 'message');
  assert.equal(call.model, options.model);
  assert.equal(call.stop_reason, 'tool_use');
  assert.deepEqual(call.content, [{ type: 'tool_use', id: 'reflexmesh_fixture_read', name: 'Read',
    input: { file_path: options.fixturePath } }]);
  const done = await post(server, second());
  assert.equal(done.status, 200);
  assert.deepEqual((await done.json()).content, [{ type: 'text', text: options.marker }]);
  assert.deepEqual(server.snapshot(), { helloRequests: 0, messageRequests: 2, tokenRequests: 1, readRequested: true,
    resultMatched: true, completed: true, unexpectedRequest: false, boundedFailure: 'none' });
  assert.ok(Object.isFrozen(server.snapshot()));
});

test('a string tool_result containing the fixture text is also valid', async t => {
  const server = await fixture(t);
  assert.equal((await post(server, first())).status, 200);
  const request = second();
  request.messages.at(-1).content[0].content = `Read returned: ${options.fixtureText}`;
  assert.equal((await post(server, request)).status, 200);
  assert.equal(server.snapshot().completed, true);
});

test('streaming uses standard named Messages SSE events and tool input JSON deltas', async t => {
  const server = await fixture(t);
  const read = await post(server, first(true));
  assert.equal(read.status, 200);
  const events = await sse(read);
  assert.deepEqual(events.map(e => e.type), ['message_start', 'content_block_start', 'content_block_delta',
    'content_block_stop', 'message_delta', 'message_stop']);
  assert.deepEqual(events[0].message.content, []);
  assert.equal(events[1].content_block.id, 'reflexmesh_fixture_read');
  assert.deepEqual(JSON.parse(events[2].delta.partial_json), { file_path: options.fixturePath });
  assert.equal(events[4].delta.stop_reason, 'tool_use');
  const done = await post(server, second(true));
  assert.equal(done.status, 200);
  const finalEvents = await sse(done);
  assert.deepEqual(finalEvents.map(e => e.type), events.map(e => e.type));
  assert.equal(finalEvents[2].delta.text, options.marker);
  assert.equal(finalEvents[4].delta.stop_reason, 'end_turn');
  assert.equal(server.snapshot().completed, true);
});

test('authentication, route, method, body size and total-request cap reject without leaks', async t => {
  const server = await fixture(t);
  const requests = [
    () => post(server, first(), { token: 'wrong-secret' }),
    () => post(server, first(), { path: '/v1/models' }),
    () => post(server, undefined, { method: 'GET' }),
    () => post(server, first(), { path: '/v1/messages?other=1' }),
    () => post(server, 'x'.repeat(1024 * 1024 + 1)),
  ];
  const statuses = [];
  for (const request of requests) {
    const response = await request();
    statuses.push(response.status);
    const body = await response.text();
    for (const secret of [options.token, options.fixturePath, options.fixtureText, 'wrong-secret']) {
      assert.equal(body.includes(secret), false);
    }
  }
  assert.deepEqual(statuses, [401, 400, 400, 400, 413]);
  for (let i = 0; i < 4; i++) {
    const response = await post(server, first());
    assert.equal(response.status, 400);
  }
  assert.equal(server.snapshot().boundedFailure, 'unauthorized');
  assert.equal(server.snapshot().unexpectedRequest, true);
  assert.equal(server.snapshot().completed, false);
  assert.equal(JSON.stringify(server.snapshot()).includes(options.token), false);
  assert.equal(JSON.stringify(server.snapshot()).includes(options.fixturePath), false);
});

test('eight total requests are the hard cap even when all are valid token counts', async t => {
  const server = await fixture(t);
  for (let i = 0; i < 8; i++) {
    const response = await post(server, { model: options.model, messages: [] },
      { path: '/v1/messages/count_tokens' });
    assert.equal(response.status, 200);
  }
  const capped = await post(server, { model: options.model, messages: [] },
    { path: '/v1/messages/count_tokens' });
  assert.equal(capped.status, 400);
  assert.deepEqual(server.snapshot(), { helloRequests: 0, messageRequests: 0, tokenRequests: 8, readRequested: false,
    resultMatched: false, completed: false, unexpectedRequest: true, boundedFailure: 'request_limit' });
});

for (const [name, payload, failure] of [
  ['wrong model', { ...first(), model: 'other' }, 'model_mismatch'],
  ['tool not offered', { ...first(), tools: [] }, 'read_tool_missing'],
  ['extra Bash tool offered', { ...first(), tools: [...first().tools, { name: 'Bash' }] }, 'read_tool_missing'],
  ['result before tool call', second(), 'read_tool_missing'],
]) test(`${name} fails closed without a tool call`, async t => {
  const server = await fixture(t);
  const response = await post(server, payload);
  assert.equal(response.status, 400);
  assert.equal(server.snapshot().readRequested, false);
  assert.equal(server.snapshot().boundedFailure, failure);
  assert.equal((await post(server, first())).status, 400);
});

for (const [name, mutate] of [
  ['wrong result ID', request => { request.messages.at(-1).content[0].tool_use_id = 'different'; }],
  ['wrong echoed Read path', request => { request.messages.at(-2).content[0].input.file_path = '/different-file'; }],
  ['extra echoed Read argument', request => { request.messages.at(-2).content[0].input.offset = 1; }],
  ['extra echoed tool call', request => { request.messages.at(-2).content.push({ type: 'tool_use',
    id: 'other', name: 'Bash', input: {} }); }],
  ['extra tool result', request => { request.messages.at(-1).content.push({ type: 'tool_result',
    tool_use_id: 'other', content: options.fixtureText }); }],
  ['fixture text absent', request => { request.messages.at(-1).content[0].content = 'not the file'; }],
  ['metadata-only proof', request => { request.messages.at(-1).content[0].content = {
    arbitraryMetadata: options.fixtureText }; }],
  ['text-block metadata-only proof', request => { request.messages.at(-1).content[0].content = [{
    type: 'text', text: 'not the file', arbitraryMetadata: options.fixtureText }]; }],
  ['non-text proof block', request => { request.messages.at(-1).content[0].content = [{
    type: 'image', source: { data: options.fixtureText } }]; }],
  ['error result', request => { request.messages.at(-1).content[0].is_error = true; }],
]) test(`${name} rejects second turn and cannot recover by retry`, async t => {
  const server = await fixture(t);
  assert.equal((await post(server, first())).status, 200);
  const request = second(); mutate(request);
  const rejected = await post(server, request);
  assert.equal(rejected.status, 400);
  assert.equal(server.snapshot().boundedFailure, 'result_mismatch');
  assert.equal(server.snapshot().resultMatched, false);
  assert.equal((await post(server, second())).status, 400);
  assert.equal(server.snapshot().completed, false);
});

test('second request with Read plus Bash is rejected even with a valid result', async t => {
  const server = await fixture(t);
  assert.equal((await post(server, first())).status, 200);
  const request = second();
  request.tools.push({ name: 'Bash' });
  assert.equal((await post(server, request)).status, 400);
  assert.equal(server.snapshot().boundedFailure, 'read_tool_missing');
  assert.equal(server.snapshot().resultMatched, false);
  assert.equal(server.snapshot().completed, false);
});

test('third Messages turn is rejected; listener is 127.0.0.1 only', async t => {
  const server = await fixture(t);
  assert.equal((await post(server, first())).status, 200);
  assert.equal((await post(server, second())).status, 200);
  assert.equal((await post(server, second())).status, 400);
  assert.equal(server.snapshot().boundedFailure, 'order_mismatch');
  const wrongHost = `http://127.0.0.2:${new URL(server.baseUrl).port}/v1/messages`;
  await assert.rejects(fetch(wrongHost, { method: 'POST', signal: AbortSignal.timeout(1000) }));
});

test('close destroys an active connection, waits for shutdown and is idempotent', async t => {
  const server = await fixture(t);
  const port = Number(new URL(server.baseUrl).port);
  const socket = createConnection({ host: '127.0.0.1', port });
  await once(socket, 'connect');
  const closed = once(socket, 'close');
  await server.close();
  await closed;
  await server.close();
});

test('one unauthenticated HEAD /api/hello handshake precedes Messages without broadening auth', async t => {
  const server = await fixture(t);
  const hello = await fetch(new URL('/api/hello', server.baseUrl), {
    method: 'HEAD', signal: AbortSignal.timeout(3000),
  });
  assert.equal(hello.status, 204);
  assert.equal(await hello.text(), '');
  assert.equal((await post(server, first())).status, 200);
  assert.equal((await post(server, second())).status, 200);
  assert.deepEqual(server.snapshot(), { helloRequests: 1, messageRequests: 2, tokenRequests: 0,
    readRequested: true, resultMatched: true, completed: true, unexpectedRequest: false, boundedFailure: 'none' });
  for (const secret of [options.token, options.fixturePath, options.fixtureText]) {
    assert.equal(JSON.stringify(server.snapshot()).includes(secret), false);
  }
});

test('duplicate hello is rejected and poisons the fixture', async t => {
  const server = await fixture(t);
  const url = new URL('/api/hello', server.baseUrl);
  assert.equal((await fetch(url, { method: 'HEAD' })).status, 204);
  assert.equal((await fetch(url, { method: 'HEAD' })).status, 400);
  assert.equal((await post(server, first())).status, 400);
  assert.equal(server.snapshot().helloRequests, 2);
  assert.equal(server.snapshot().boundedFailure, 'unsupported_route');
});

for (const [name, path, method] of [
  ['query', '/api/hello?beta=true', 'HEAD'],
  ['wrong method', '/api/hello', 'GET'],
  ['wrong path', '/api/hello/extra', 'HEAD'],
]) test(`hello ${name} is rejected without leaking fixture inputs`, async t => {
  const server = await fixture(t);
  const response = await fetch(new URL(path, server.baseUrl), { method, signal: AbortSignal.timeout(3000) });
  assert.equal(response.status, 400);
  assert.equal((await post(server, first())).status, 400);
  assert.equal(server.snapshot().unexpectedRequest, true);
  const snapshot = JSON.stringify(server.snapshot());
  for (const secret of [options.token, options.fixturePath, options.fixtureText]) assert.equal(snapshot.includes(secret), false);
});

test('hello with a request body is rejected, even with correct path and method', async t => {
  const server = await fixture(t);
  const status = await new Promise((resolve, reject) => {
    const call = request(new URL('/api/hello', server.baseUrl), { method: 'HEAD', headers: { 'content-length': '1' } },
      response => { response.resume(); response.on('end', () => resolve(response.statusCode)); });
    call.on('error', reject);
    call.end('x');
  });
  assert.equal(status, 400);
  assert.equal(server.snapshot().helloRequests, 1);
  assert.equal(server.snapshot().boundedFailure, 'unsupported_route');
  assert.equal((await post(server, first())).status, 400);
});

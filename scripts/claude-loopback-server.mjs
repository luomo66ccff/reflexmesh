import { createServer } from 'node:http';

const MAX_BODY_BYTES = 1024 * 1024;
const MAX_REQUESTS = 8;
const TOOL_ID = 'reflexmesh_fixture_read';
const bounded = (value, max) => typeof value === 'string' && value.length > 0
  && value.length <= max && !value.includes('\0');
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);

function containsFixtureText(content, fixtureText) {
  if (typeof content === 'string') return content.includes(fixtureText);
  if (!Array.isArray(content) || content.length === 0
    || !content.every(block => object(block) && block.type === 'text' && typeof block.text === 'string')) {
    return false;
  }
  return content.map(block => block.text).join('').includes(fixtureText);
}

function readOnlyTool(tools) {
  return Array.isArray(tools) && tools.length === 1 && object(tools[0]) && tools[0].name === 'Read';
}

function readToolResult(messages, fixturePath, fixtureText) {
  if (!Array.isArray(messages) || messages.length < 2) return false;
  const prior = messages.at(-2), last = messages.at(-1);
  if (prior?.role !== 'assistant' || !Array.isArray(prior.content)
    || last?.role !== 'user' || !Array.isArray(last.content)) return false;
  const blocks = messages.flatMap(item => Array.isArray(item?.content) ? item.content : []);
  const uses = blocks.filter(block => block?.type === 'tool_use');
  const results = blocks.filter(block => block?.type === 'tool_result');
  if (uses.length !== 1 || results.length !== 1) return false;
  const use = uses[0], result = results[0];
  return prior.content.includes(use) && last.content.includes(result)
    && use.id === TOOL_ID && use.name === 'Read' && object(use.input)
    && Object.keys(use.input).length === 1 && use.input.file_path === fixturePath
    && result.tool_use_id === TOOL_ID
    && (result.is_error === undefined || result.is_error === false)
    && containsFixtureText(result.content, fixtureText);
}

function message(model, content, stopReason, id) {
  return { id, type: 'message', role: 'assistant', model, content, stop_reason: stopReason,
    stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } };
}

function sendJson(res, status, value) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(value));
}

function sendStream(res, model, block, stopReason, id) {
  res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-store', connection: 'close' });
  const event = (type, payload) => res.write(`event: ${type}\ndata: ${JSON.stringify(payload)}\n\n`);
  event('message_start', { type: 'message_start', message: message(model, [], null, id) });
  if (block.type === 'tool_use') {
    event('content_block_start', { type: 'content_block_start', index: 0,
      content_block: { type: 'tool_use', id: block.id, name: block.name, input: {} } });
    event('content_block_delta', { type: 'content_block_delta', index: 0,
      delta: { type: 'input_json_delta', partial_json: JSON.stringify(block.input) } });
  } else {
    event('content_block_start', { type: 'content_block_start', index: 0,
      content_block: { type: 'text', text: '' } });
    event('content_block_delta', { type: 'content_block_delta', index: 0,
      delta: { type: 'text_delta', text: block.text } });
  }
  event('content_block_stop', { type: 'content_block_stop', index: 0 });
  event('message_delta', { type: 'message_delta', delta: { stop_reason: stopReason, stop_sequence: null },
    usage: { output_tokens: 1 } });
  event('message_stop', { type: 'message_stop' });
  res.end();
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const parts = [];
    let size = 0;
    req.on('data', chunk => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        req.pause();
        reject(new RangeError('body_limit'));
      } else parts.push(chunk);
    });
    req.once('end', () => resolve(Buffer.concat(parts).toString('utf8')));
    req.once('error', reject);
    req.once('aborted', () => reject(new Error('aborted')));
  });
}

/** Offline, single-use Claude Messages fixture. It never opens an upstream connection. */
export async function startClaudeFixture({ model, fixturePath, fixtureText, token, marker } = {}) {
  if (![model, fixturePath, fixtureText, token, marker].every((value, index) =>
    bounded(value, index === 1 ? 4096 : index === 2 ? 65536 : 1024))) {
    throw new TypeError('Invalid Claude fixture options');
  }
  let totalRequests = 0, helloRequests = 0, messageRequests = 0, tokenRequests = 0, stage = 0;
  let readRequested = false, resultMatched = false, completed = false, unexpectedRequest = false;
  let boundedFailure = 'none';
  const sockets = new Set();
  const fail = (res, status, reason) => {
    unexpectedRequest = true;
    if (boundedFailure === 'none') boundedFailure = reason;
    stage = 3; // No retry can turn an invalid synthetic exchange into a pass.
    sendJson(res, status, { type: 'error', error: {
      type: status === 401 ? 'authentication_error' : 'invalid_request_error',
      message: 'Synthetic fixture rejected request',
    } });
  };
  const server = createServer(async (req, res) => {
    totalRequests++;
    if (totalRequests > MAX_REQUESTS) return fail(res, 400, 'request_limit');
    let route, url;
    try {
      if (!req.url?.startsWith('/') || req.url.startsWith('//')) throw new Error('route');
      url = new URL(req.url, 'http://127.0.0.1');
      route = url.pathname;
    } catch { return fail(res, 400, 'unsupported_route'); }
    // Observed in Claude CLI 2.1.263 before Messages. This is a fixture-only,
    // exact-path handshake, not a general API or a documented compatibility claim.
    if (req.method === 'HEAD' && route === '/api/hello') {
      helloRequests++;
      if (helloRequests !== 1 || stage !== 0 || req.url.includes('?')
        || (req.headers['content-length'] !== undefined && req.headers['content-length'] !== '0')
        || req.headers['transfer-encoding'] !== undefined) return fail(res, 400, 'unsupported_route');
      res.writeHead(204, { 'cache-control': 'no-store' });
      return res.end();
    }
    if ([...url.searchParams.keys()].some(key => key !== 'beta')) return fail(res, 400, 'unsupported_route');
    if (req.method !== 'POST' || !['/v1/messages', '/v1/messages/count_tokens'].includes(route)) {
      return fail(res, 400, 'unsupported_route');
    }
    if (route === '/v1/messages') messageRequests++;
    else tokenRequests++;
    if (req.headers['x-api-key'] !== token) return fail(res, 401, 'unauthorized');
    const length = Number(req.headers['content-length']);
    if (Number.isFinite(length) && length > MAX_BODY_BYTES) return fail(res, 413, 'body_limit');
    let payload;
    try { payload = JSON.parse(await readBody(req)); }
    catch (error) { return fail(res, error instanceof RangeError ? 413 : 400,
      error instanceof RangeError ? 'body_limit' : 'invalid_json'); }
    if (!object(payload)) return fail(res, 400, 'invalid_json');
    if (payload.model !== model) return fail(res, 400, 'model_mismatch');
    if (route === '/v1/messages/count_tokens') return sendJson(res, 200, { input_tokens: 1 });
    if (payload.stream !== undefined && typeof payload.stream !== 'boolean') return fail(res, 400, 'invalid_json');
    if (!readOnlyTool(payload.tools)) return fail(res, 400, 'read_tool_missing');
    let block, stopReason, id;
    if (stage === 0) {
      if (!Array.isArray(payload.messages) || payload.messages.length === 0
        || payload.messages.some(item => Array.isArray(item?.content)
          && item.content.some(content => ['tool_use', 'tool_result'].includes(content?.type)))) {
        return fail(res, 400, 'read_tool_missing');
      }
      block = { type: 'tool_use', id: TOOL_ID, name: 'Read', input: { file_path: fixturePath } };
      stopReason = 'tool_use'; id = 'msg_reflexmesh_fixture_read';
      readRequested = true; stage = 1;
    } else if (stage === 1) {
      if (!readToolResult(payload.messages, fixturePath, fixtureText)) return fail(res, 400, 'result_mismatch');
      block = { type: 'text', text: marker };
      stopReason = 'end_turn'; id = 'msg_reflexmesh_fixture_done';
      resultMatched = true; completed = true; stage = 2;
    } else return fail(res, 400, 'order_mismatch');
    if (payload.stream === true) sendStream(res, model, block, stopReason, id);
    else sendJson(res, 200, message(model, [block], stopReason, id));
  });
  server.on('connection', socket => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  server.requestTimeout = 5000;
  server.headersTimeout = 5000;
  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
  } catch (error) { server.close(); throw error; }
  const address = server.address();
  let closing;
  return Object.freeze({
    baseUrl: `http://127.0.0.1:${address.port}`,
    snapshot: () => Object.freeze({ helloRequests, messageRequests, tokenRequests, readRequested, resultMatched,
      completed, unexpectedRequest, boundedFailure }),
    close: () => closing ??= new Promise((resolve, reject) => {
      server.close(error => error ? reject(error) : resolve());
      for (const socket of sockets) socket.destroy();
    }),
  });
}

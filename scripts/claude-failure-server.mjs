import { createServer } from 'node:http';

export const FAILURE_TOOL = 'mcp__reflexmesh_fixture__outcome';
export const FAILURE_CALLS = Object.freeze([
  Object.freeze({ type: 'tool_use', id: 'fixture_ok', name: FAILURE_TOOL, input: Object.freeze({ mode: 'ok' }) }),
  Object.freeze({ type: 'tool_use', id: 'fixture_fail', name: FAILURE_TOOL, input: Object.freeze({ mode: 'fail' }) }),
]);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const contentText = value => typeof value === 'string' ? value : Array.isArray(value)
  && value.every(item => item?.type === 'text' && typeof item.text === 'string')
    ? value.map(item => item.text).join('') : null;
const message = (model, content, stop_reason, id) => ({ id, type: 'message', role: 'assistant', model,
  content, stop_reason, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } });
function respond(res, model, content, stopReason, stage, stream) {
  const id = `msg_synthetic_failure_${stage}`;
  if (!stream) { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify(message(model, content, stopReason, id))); }
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'close' });
  const event = (type, value) => res.write(`event: ${type}\ndata: ${JSON.stringify(value)}\n\n`);
  event('message_start', { type: 'message_start', message: message(model, [], null, id) });
  content.forEach((block, index) => {
    event('content_block_start', { type: 'content_block_start', index, content_block: block.type === 'tool_use'
      ? { ...block, input: {} } : { type: 'text', text: '' } });
    event('content_block_delta', { type: 'content_block_delta', index, delta: block.type === 'tool_use'
      ? { type: 'input_json_delta', partial_json: JSON.stringify(block.input) } : { type: 'text_delta', text: block.text } });
    event('content_block_stop', { type: 'content_block_stop', index });
  });
  event('message_delta', { type: 'message_delta', delta: { stop_reason: stopReason, stop_sequence: null }, usage: { output_tokens: 1 } });
  event('message_stop', { type: 'message_stop' }); res.end();
}

export function matchesFailureResults(messages, { okText, failText }) {
  if (!Array.isArray(messages)) return false;
  const blocks = messages.flatMap(item => Array.isArray(item?.content) ? item.content : []);
  const uses = blocks.filter(item => item?.type === 'tool_use'), results = blocks.filter(item => item?.type === 'tool_result');
  if (uses.length !== 2 || results.length !== 2) return false;
  const batch = messages.findIndex(item => item?.role === 'assistant' && Array.isArray(item.content)
    && uses.every(use => item.content.includes(use)));
  if (batch < 0 || results.some(result => !messages.some((item, index) => index > batch
    && item?.role === 'user' && Array.isArray(item.content) && item.content.includes(result)))) return false;
  return FAILURE_CALLS.every(call => {
    const use = uses.find(item => item.id === call.id), result = results.find(item => item.tool_use_id === call.id);
    return use?.name === FAILURE_TOOL && JSON.stringify(use.input) === JSON.stringify(call.input)
      && result && (call.id === 'fixture_fail' ? result.is_error === true : [undefined, false].includes(result.is_error))
      && contentText(result.content)?.includes(call.id === 'fixture_fail' ? failText : okText);
  });
}

/** Bounded synthetic-only Messages fixture: one two-tool batch and one final reply. */
export async function startClaudeFailureFixture({ model, token, okText, failText, marker }) {
  if (![model, token, okText, failText, marker].every(value => typeof value === 'string' && value.length > 0 && value.length <= 1024)) throw new TypeError('Invalid fixture options');
  let total = 0, stage = 0, helloRequests = 0, messageRequests = 0, resultMatched = false;
  let boundedFailure = 'none';
  const sockets = new Set();
  const fail = (res, reason) => {
    boundedFailure = boundedFailure === 'none' ? reason : boundedFailure; stage = 3;
    res.writeHead(400, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: 'Synthetic fixture rejected request' } }));
  };
  const server = createServer(async (req, res) => {
    if (++total > 8) return fail(res, 'request_limit');
    if (req.method === 'HEAD' && req.url === '/api/hello') {
      if (++helloRequests !== 1 || stage !== 0 || req.headers['transfer-encoding'] !== undefined
        || ![undefined, '0'].includes(req.headers['content-length'])) return fail(res, 'unexpected_request');
      res.writeHead(204); return res.end();
    }
    if (req.method !== 'POST' || !/^\/v1\/messages(?:\?beta=[^&]*)?$/.test(req.url ?? '')) return fail(res, 'unexpected_request');
    messageRequests++;
    if (req.headers['x-api-key'] !== token) return fail(res, 'unauthorized');
    let payload, size = 0; const chunks = [];
    try {
      for await (const chunk of req) {
        size += chunk.length; if (size > 1024 * 1024) return fail(res, 'body_limit'); chunks.push(chunk);
      }
      payload = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch { return fail(res, 'invalid_json'); }
    if (!object(payload) || payload.model !== model || (payload.stream !== undefined && typeof payload.stream !== 'boolean')) return fail(res, 'invalid_model_request');
    if (!Array.isArray(payload.tools) || payload.tools.length !== 1 || payload.tools[0]?.name !== FAILURE_TOOL) return fail(res, 'unexpected_tools');
    if (stage === 0) {
      if (!Array.isArray(payload.messages) || !payload.messages.length || payload.messages.some(item => Array.isArray(item?.content)
        && item.content.some(block => ['tool_use', 'tool_result'].includes(block?.type)))) return fail(res, 'unexpected_history');
      stage = 1; return respond(res, model, FAILURE_CALLS, 'tool_use', stage, payload.stream);
    }
    if (stage !== 1 || !matchesFailureResults(payload.messages, { okText, failText })) return fail(res, 'result_mismatch');
    resultMatched = true; stage = 2;
    respond(res, model, [{ type: 'text', text: marker }], 'end_turn', stage, payload.stream);
  });
  server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  server.requestTimeout = 5000; server.headersTimeout = 5000;
  try { await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); }); }
  catch (error) { server.close(); throw error; }
  let closing;
  return { baseUrl: `http://127.0.0.1:${server.address().port}`,
    snapshot: () => ({ helloRequests, messageRequests, resultMatched, completed: stage === 2, boundedFailure }),
    close: () => closing ??= new Promise((resolve, reject) => {
      server.close(error => error ? reject(error) : resolve()); for (const socket of sockets) socket.destroy();
    }) };
}

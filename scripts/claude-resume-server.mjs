import { createServer } from 'node:http';
import { listenLoopback } from './loopback-listen.mjs';

export const RESUME_TOOL = 'mcp__reflexmesh_fixture__read';
export const resumeCall = phase => ({ type: 'tool_use', id: `resume_call_${phase}`, name: RESUME_TOOL, input: { phase } });
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const blocks = messages => messages.flatMap(item => Array.isArray(item?.content) ? item.content : []);
const contentText = value => typeof value === 'string' ? value : Array.isArray(value)
  && value.every(item => item?.type === 'text' && typeof item.text === 'string') ? value.map(item => item.text).join('') : null;
const message = (content, stop_reason, id) => ({ id, type: 'message', role: 'assistant', model: 'claude-sonnet-4-6',
  content, stop_reason, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } });
function respond(res, content, stopReason, stage, stream) {
  const id = `msg_synthetic_resume_${stage}`;
  if (!stream) { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify(message(content, stopReason, id))); }
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'close' });
  const event = (type, value) => res.write(`event: ${type}\ndata: ${JSON.stringify(value)}\n\n`);
  event('message_start', { type: 'message_start', message: message([], null, id) });
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

export function matchesResumeHistory(messages, { phase, interrupted, proof, firstPrompt, secondPrompt }) {
  if (!Array.isArray(messages) || messages.some(item => !object(item) || !['user', 'assistant'].includes(item.role))) return false;
  const all = blocks(messages), uses = all.filter(item => item?.type === 'tool_use');
  const results = all.filter(item => item?.type === 'tool_result');
  if (!['first', 'first-result', 'resume', 'resume-result'].includes(phase)) return false;
  const resumed = ['resume', 'resume-result'].includes(phase);
  const promptIndex = prompt => messages.findIndex(item => item.role === 'user' && contentText(item.content)?.includes(prompt));
  const firstIndex = promptIndex(firstPrompt), secondIndex = promptIndex(secondPrompt);
  if (firstIndex < 0 || resumed && secondIndex <= firstIndex) return false;
  if (!resumed && secondIndex >= 0) return false;
  const expectedUses = phase === 'first' ? [] : phase === 'first-result' || phase === 'resume' ? [1] : [1, 2];
  // Pinned 2.1.263 removes an unfinished tool-use block from the Messages view on resume.
  // Require its exact replacement and the earlier prompt; never treat this as a tool outcome.
  if (resumed && interrupted) {
    expectedUses.splice(expectedUses.indexOf(1), 1);
    if (!messages.some((item, index) => item.role === 'assistant' && contentText(item.content) === 'No response requested.'
      && index > firstIndex && index < secondIndex)) return false;
  }
  if (uses.length !== expectedUses.length || !expectedUses.every(n => uses.some(use => JSON.stringify(use) === JSON.stringify(resumeCall(n))))) return false;
  if (results.length !== expectedUses.length) return false;
  return expectedUses.every(n => {
    const useIndex = messages.findIndex(item => item.role === 'assistant' && Array.isArray(item.content) && item.content.some(block => block?.id === `resume_call_${n}`));
    const matching = results.filter(result => result.tool_use_id === `resume_call_${n}`);
    const resultIndex = messages.findIndex(item => item.role === 'user' && Array.isArray(item.content) && item.content.includes(matching[0]));
    if (useIndex < 0 || useIndex <= (n === 1 ? firstIndex : secondIndex) || matching.length !== 1 || resultIndex <= useIndex
      || n === 1 && resumed && resultIndex >= secondIndex) return false;
    return [undefined, false].includes(matching[0].is_error) && contentText(matching[0].content)?.includes(`${proof}_${n}`);
  });
}

/** Two process turns, bounded localhost-only synthetic Messages and memory-only MCP receipts. */
export async function startClaudeResumeFixture({ token, proof, firstPrompt, secondPrompt, interrupted, onEntered }) {
  if (![token, proof, firstPrompt, secondPrompt].every(value => typeof value === 'string' && value.length > 0 && value.length <= 2048)
    || typeof interrupted !== 'boolean' || typeof onEntered !== 'function') throw new TypeError('Invalid fixture options');
  let stage = 'first', total = 0, helloRequests = 0, messageRequests = 0, resumedHistory = false, failure = 'none';
  const entries = [], sockets = new Set();
  const fail = (res, reason) => { failure = failure === 'none' ? reason : failure;
    res.writeHead(400, { 'content-type': 'application/json' }); res.end('{"error":{"type":"invalid_request_error","message":"Synthetic fixture rejected request"}}'); };
  const server = createServer(async (req, res) => {
    if (++total > 16) return fail(res, 'request_limit');
    if (failure !== 'none') return fail(res, failure);
    if (req.method === 'HEAD' && req.url === '/api/hello') {
      if (++helloRequests > 2 || req.headers['transfer-encoding'] !== undefined || ![undefined, '0'].includes(req.headers['content-length'])) return fail(res, 'unexpected_request');
      res.writeHead(204); return res.end();
    }
    if (req.method !== 'POST' || req.headers['x-api-key'] !== token) return fail(res, 'unexpected_request');
    let payload, size = 0; const chunks = [];
    try { for await (const chunk of req) { size += chunk.length; if (size > 1024 * 1024) return fail(res, 'body_limit'); chunks.push(chunk); }
      payload = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { return fail(res, 'invalid_json'); }
    if (req.url === '/fixture/rejected') return fail(res, 'tool_protocol_rejected');
    if (req.url === '/fixture/entered') {
      const phase = payload?.phase;
      if (!object(payload) || Object.keys(payload).sort().join(',') !== 'phase,pid' || ![1, 2].includes(phase)
        || !Number.isSafeInteger(payload.pid) || payload.pid <= 0 || entries.some(item => item.phase === phase)
        || stage !== (phase === 1 ? 'first-result' : 'resume-result')) return fail(res, 'unexpected_tool');
      entries.push({ phase, pid: payload.pid, returned: !(phase === 1 && interrupted) });
      if (phase === 1 && interrupted) { Promise.resolve().then(onEntered).catch(() => { failure = 'barrier_failed'; }); return; }
      res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ text: `${proof}_${phase}` }));
    }
    if (!/^\/v1\/messages(?:\?beta=[^&]*)?$/.test(req.url ?? '')) return fail(res, 'unexpected_request');
    messageRequests++;
    if (!object(payload) || payload.model !== 'claude-sonnet-4-6' || (payload.stream !== undefined && typeof payload.stream !== 'boolean')
      || !Array.isArray(payload.tools) || payload.tools.length !== 1 || payload.tools[0]?.name !== RESUME_TOOL) return fail(res, 'invalid_model_request');
    if (!matchesResumeHistory(payload.messages, { phase: stage, interrupted, proof, firstPrompt, secondPrompt })) return fail(res, 'history_mismatch');
    if (stage === 'first' || stage === 'resume') {
      const phase = stage === 'first' ? 1 : 2;
      if (phase === 2) resumedHistory = true;
      stage = phase === 1 ? 'first-result' : 'resume-result';
      return respond(res, [resumeCall(phase)], 'tool_use', stage, payload.stream);
    }
    if (!['first-result', 'resume-result'].includes(stage)) return fail(res, 'unexpected_stage');
    if (stage === 'first-result' && interrupted) return fail(res, 'unexpected_completion');
    const phase = stage === 'first-result' ? 1 : 2;
    stage = phase === 1 ? 'await-resume' : 'done';
    return respond(res, [{ type: 'text', text: `REFLEXMESH_RESUME_OK_${phase}` }], 'end_turn', stage, payload.stream);
  });
  server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  server.requestTimeout = 5000; server.headersTimeout = 5000;
  await listenLoopback(server);
  return { baseUrl: `http://127.0.0.1:${server.address().port}`,
    resume() { if (stage !== (interrupted ? 'first-result' : 'await-resume')) throw new Error('invalid_resume_stage'); stage = 'resume'; },
    snapshot: () => ({ stage, helloRequests, messageRequests, resumedHistory, entries: entries.map(item => ({ ...item })), failure }),
    close: () => new Promise((resolve, reject) => { server.close(error => error ? reject(error) : resolve()); for (const socket of sockets) socket.destroy(); }) };
}

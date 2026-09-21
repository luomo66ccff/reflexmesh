import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, mkdirSync, writeFileSync, realpathSync, rmSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { Readable, Writable } from 'node:stream';
import { matchesResumeHistory, resumeCall, RESUME_TOOL, startClaudeResumeFixture } from '../scripts/claude-resume-server.mjs';
import { findResumeTranscript, runResumeHost, validResumeHooks, main } from '../scripts/claude-resume-probe.mjs';
import { resumeToolMain } from '../scripts/claude-resume-tools.mjs';

const base = { token: `synthetic-${randomUUID()}`, proof: 'SYNTHETIC_PROOF', firstPrompt: 'first synthetic task', secondPrompt: 'second synthetic task' };
const user = content => ({ role: 'user', content });
const assistant = content => ({ role: 'assistant', content });
const result = phase => ({ type: 'tool_result', tool_use_id: `resume_call_${phase}`, content: [{ type: 'text', text: `${base.proof}_${phase}` }] });
const history = (phase, interrupted = false) => {
  const messages = [user(base.firstPrompt)];
  if (phase === 'first') return messages;
  if (!interrupted || phase === 'first-result') messages.push(assistant([resumeCall(1)]), user([result(1)]));
  else messages.push(assistant([{ type: 'text', text: 'No response requested.' }]));
  if (phase === 'first-result') return messages;
  messages.push(user(base.secondPrompt));
  if (phase === 'resume-result') messages.push(assistant([resumeCall(2)]), user([result(2)]));
  return messages;
};
const payload = (phase, interrupted = false, stream = false) => ({ model: 'claude-sonnet-4-6', stream,
  tools: [{ name: RESUME_TOOL }], messages: history(phase, interrupted) });
const post = (server, data, path = '/v1/messages', token = base.token) => fetch(server.baseUrl + path, { method: 'POST',
  headers: { 'x-api-key': token, 'content-type': 'application/json' }, body: typeof data === 'string' ? data : JSON.stringify(data), signal: AbortSignal.timeout(2000) });
async function serverFixture(t, interrupted = false, onEntered = () => {}) {
  const server = await startClaudeResumeFixture({ ...base, interrupted, onEntered }); t.after(() => server.close()); return server;
}

for (const interrupted of [false, true]) test(`strict resumed history (${interrupted ? 'killed' : 'clean'})`, () => {
  for (const phase of ['first', 'first-result', 'resume', 'resume-result'])
    assert.equal(matchesResumeHistory(history(phase, interrupted), { ...base, phase, interrupted }), true);
});
for (const [name, mutate] of [
  ['missing old prompt', h => h.shift()],
  ['new task precedes old task', h => { h.unshift(h.splice(3, 1)[0]); }],
  ['tool use owned by user', h => { h[1].role = 'user'; }],
  ['result owned by assistant', h => { h[2].role = 'assistant'; }],
  ['result precedes tool use', h => { [h[1], h[2]] = [h[2], h[1]]; }],
  ['wrong tool name', h => { h[1].content[0].name = 'Bash'; }],
  ['changed arguments', h => { h[1].content[0].input.phase = 2; }],
  ['repeated old call', h => { h[1].content.push(resumeCall(1)); }],
  ['foreign result', h => { h[2].content[0].tool_use_id = 'foreign'; }],
  ['fabricated proof', h => { h[2].content[0].content[0].text = 'wrong'; }],
  ['failed old result', h => { h[2].content[0].is_error = true; }],
  ['extra result', h => { h[2].content.push(result(1)); }],
]) test(`resumed history rejects ${name}`, () => {
  const input = history('resume'); mutate(input);
  assert.equal(matchesResumeHistory(input, { ...base, phase: 'resume', interrupted: false }), false);
});
for (const [name, mutate] of [
  ['missing placeholder', h => h.splice(1, 1)],
  ['wrong placeholder', h => { h[1].content[0].text = 'Succeeded'; }],
  ['placeholder owned by user', h => { h[1].role = 'user'; }],
  ['new prompt before placeholder', h => { [h[1], h[2]] = [h[2], h[1]]; }],
  ['retained old tool use', h => { h[1].content.push(resumeCall(1)); }],
  ['invented old result', h => { h.push(user([result(1)])); }],
]) test(`killed history rejects ${name}`, () => {
  const input = history('resume', true); mutate(input);
  assert.equal(matchesResumeHistory(input, { ...base, phase: 'resume', interrupted: true }), false);
});

test('strict local server completes exactly two turns with distinct tool receipts', async t => {
  const server = await serverFixture(t);
  for (const phase of [1, 2]) {
    assert.equal((await fetch(server.baseUrl + '/api/hello', { method: 'HEAD' })).status, 204);
    if (phase === 2) server.resume();
    const response = await post(server, payload(phase === 1 ? 'first' : 'resume'));
    assert.deepEqual((await response.json()).content, [resumeCall(phase)]);
    const tool = await post(server, { phase, pid: phase }, '/fixture/entered');
    assert.deepEqual(await tool.json(), { text: `${base.proof}_${phase}` });
    assert.equal((await post(server, payload(phase === 1 ? 'first-result' : 'resume-result'))).status, 200);
  }
  assert.equal(server.snapshot().stage, 'done'); assert.equal(server.snapshot().resumedHistory, true);
  assert.equal(server.snapshot().entries.length, 2); assert.equal(server.snapshot().failure, 'none');
});
test('interrupted memory-only tool stops at an observed barrier without a returned result', async t => {
  let release; const entered = new Promise(resolve => { release = resolve; });
  const server = await serverFixture(t, true, release);
  await post(server, payload('first', true));
  const controller = new AbortController();
  const pending = fetch(server.baseUrl + '/fixture/entered', { method: 'POST', headers: { 'x-api-key': base.token }, body: JSON.stringify({ phase: 1, pid: 1 }), signal: controller.signal }).catch(() => null);
  await entered; assert.deepEqual(server.snapshot().entries, [{ phase: 1, pid: 1, returned: false }]);
  controller.abort(); await pending; server.resume();
  assert.equal((await post(server, payload('resume', true))).status, 200);
  await post(server, { phase: 2, pid: 2 }, '/fixture/entered');
  assert.equal((await post(server, payload('resume-result', true))).status, 200);
  assert.equal(server.snapshot().stage, 'done');
});
test('streaming fixture emits an exact call and rejects retry after invalid history', async t => {
  const server = await serverFixture(t);
  const response = await post(server, payload('first', false, true));
  const text = await response.text(); assert.match(text, /text|tool_use/); assert.match(text, /resume_call_1/);
  assert.match(response.headers.get('content-type'), /text\/event-stream/);
  assert.equal((await post(server, payload('resume'))).status, 400);
  assert.equal((await post(server, payload('first-result'))).status, 400);
  assert.equal(server.snapshot().failure, 'history_mismatch');
});
for (const [name, data, path, token] of [
  ['bad JSON', 'private-invalid-json'],
  ['bad model', { ...payload('first'), model: 'private-unknown-model' }],
  ['extra tool', { ...payload('first'), tools: [{ name: RESUME_TOOL }, { name: 'Bash' }] }],
  ['wrong credential', payload('first'), '/v1/messages', 'private-wrong-token'],
  ['wrong route', payload('first'), '/v1/models'],
  ['oversized body', 'x'.repeat(1024 * 1024 + 1)],
]) test(`fixture fails closed and redacted for ${name}`, async t => {
  const server = await serverFixture(t);
  const response = await post(server, data, path, token); assert.equal(response.status, 400);
  assert.equal((await response.text()).includes('private'), false);
  assert.equal((await post(server, payload('first'))).status, 400);
});
test('fixture rejects unknown/repeated tool entry and phase changes', async t => {
  const server = await serverFixture(t); await post(server, payload('first'));
  assert.equal((await post(server, { phase: 2, pid: 1 }, '/fixture/entered')).status, 400);
  assert.equal((await post(server, { phase: 1, pid: 1 }, '/fixture/entered')).status, 400);
});

test('transcript discovery is confined to exact session under fresh projects', t => {
  const root = realpathSync(tmpdir()), directory = mkdtempSync(join(root, 'reflexmesh-resume-test-'));
  t.after(() => { const target = realpathSync(directory); assert.equal(dirname(target), root); assert.ok(basename(target).startsWith('reflexmesh-resume-test-')); rmSync(target, { recursive: true, force: true }); });
  const id = randomUUID(); assert.equal(findResumeTranscript(directory, id), null);
  assert.throws(() => findResumeTranscript(directory, '../../foreign'));
  mkdirSync(join(directory, 'projects', 'synthetic'), { recursive: true });
  const file = join(directory, 'projects', 'synthetic', `${id}.jsonl`);
  writeFileSync(file, '{}\n'); assert.equal(findResumeTranscript(directory, id), file);
  assert.equal(findResumeTranscript(directory, randomUUID()), null);
  mkdirSync(join(directory, 'projects', 'second')); writeFileSync(join(directory, 'projects', 'second', `${id}.jsonl`), '{}');
  assert.throws(() => findResumeTranscript(directory, id), /ambiguous/);
});
test('owned bounded process receipts include exit identity without stderr', async () => {
  const result = await runResumeHost(process.execPath, ['-e', 'process.stderr.write("private");process.stdout.write("synthetic");'], { cwd: process.cwd(), env: { SystemRoot: process.env.SystemRoot }, timeoutMs: 2000 });
  assert.equal(result.ok, true); assert.equal(result.closed, true); assert.equal(result.stdout, 'synthetic');
  assert.ok(result.pid > 0); assert.equal(JSON.stringify(result).includes('private'), false);
});
test('owned process abortion requires actual close and is never success', async () => {
  const controller = new AbortController();
  const result = runResumeHost(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { cwd: process.cwd(), env: { SystemRoot: process.env.SystemRoot }, signal: controller.signal, timeoutMs: 3000 });
  controller.abort(); const closed = await result;
  assert.equal(closed.closed, true); assert.equal(closed.kind, 'barrier_terminated'); assert.equal(closed.ok, false);
});
test('owned process deadline and spawn failure cannot claim close success', async () => {
  const timed = await runResumeHost(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { cwd: process.cwd(), env: { SystemRoot: process.env.SystemRoot }, timeoutMs: 50 });
  assert.equal(timed.kind, 'timeout'); assert.equal(timed.ok, false);
  const absent = await runResumeHost(join(process.cwd(), 'no-such-executable'), [], { cwd: process.cwd(), env: {}, timeoutMs: 2000 });
  assert.equal(absent.kind, 'spawn_error'); assert.equal(absent.closed, false);
});
test('tool fixture validates argv and protocol before network', async () => {
  for (const args of [[], ['https://remote.example', base.token, '1'], ['http://127.0.0.1:1', 'bad-token', '1'], ['http://127.0.0.1:1', base.token, '3']])
    assert.equal(await resumeToolMain(args, Readable.from([]), new Writable({ write(c, e, cb) { cb(); } })), 1);
  const invalid = { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'read', arguments: { phase: 2 } } };
  assert.equal(await resumeToolMain(['http://127.0.0.1:1', base.token, '1'], Readable.from([JSON.stringify(invalid) + '\n']), new Writable({ write(c, e, cb) { cb(); } })), 1);
});
for (const [name, last] of [
  ['unknown RPC', { jsonrpc: '2.0', id: 2, method: 'unknown/rpc' }],
  ['duplicate call', { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'read', arguments: { phase: 1 } } }],
  ['bad JSON', '{invalid-private'],
  ['oversized line', 'x'.repeat(65537)],
]) test(`MCP rejection after success remains visible: ${name}`, async t => {
  const server = await serverFixture(t); await post(server, payload('first'));
  const call = { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'read', arguments: { phase: 1 } } };
  let output = '';
  assert.equal(await resumeToolMain([server.baseUrl, base.token, '1'], Readable.from([JSON.stringify(call) + '\n', (typeof last === 'string' ? last : JSON.stringify(last)) + '\n']),
    new Writable({ write(c, e, cb) { output += c.toString(); cb(); } })), 1);
  assert.equal(JSON.parse(output).result.content[0].text, `${base.proof}_1`);
  assert.equal(server.snapshot().failure, 'tool_protocol_rejected');
  assert.equal((await post(server, payload('first-result'))).status, 400);
});
const hookEvents = ['UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'Stop'];
const hookStream = () => [...hookEvents.flatMap((hook_event, index) => [
  { type: 'system', subtype: 'hook_started', hook_event, hook_id: String(index), session_id: 'synthetic-session' },
  { type: 'system', subtype: 'hook_response', hook_event, hook_id: String(index), session_id: 'synthetic-session', exit_code: 0, outcome: 'success', stdout: '{}', stderr: '' },
]), { type: 'result' }];
test('hook lifecycle accepts only exact complete pairs and bounded SQLite warning', () => {
  const stream = hookStream(); assert.equal(validResumeHooks(stream, hookEvents, 'synthetic-session', true), true);
  stream[1].stderr = '(node:123) ExperimentalWarning: SQLite is an experimental feature and might change at any time\n(Use `node --trace-warnings ...` to show where the warning was created)\n';
  assert.equal(validResumeHooks(stream, hookEvents, 'synthetic-session', true), true);
  assert.equal(validResumeHooks(stream.slice(0, 4), hookEvents.slice(0, 2), 'synthetic-session', false), true);
});
for (const [name, mutate] of [
  ['observer warning', s => { s[1].stderr = 'ReflexMesh task observation unavailable\n'; }],
  ['wrong hook id', s => { s[1].hook_id = 'wrong'; }],
  ['foreign session', s => { s[1].session_id = 'foreign'; }],
  ['failed hook', s => { s[1].exit_code = 1; }],
  ['permission stdout', s => { s[1].stdout = '{"decision":"allow"}'; }],
  ['responses before starts', s => { [s[0], s[1]] = [s[1], s[0]]; }],
  ['Stop before post', s => { s.splice(4, 0, ...s.splice(6, 2)); }],
  ['final before hooks', s => { s.unshift(s.pop()); }],
  ['missing response', s => { s.splice(1, 1); }],
  ['extra lifecycle event', s => { s.push({ ...s[1], hook_event: 'StopFailure' }); }],
]) test(`hook lifecycle rejects ${name}`, () => {
  const stream = hookStream(); mutate(stream); assert.equal(validResumeHooks(stream, hookEvents, 'synthetic-session', true), false);
});
test('CLI help and invalid options never run a host', async () => {
  let text = ''; const output = { write: value => { text += value; } };
  assert.equal(await main(['--help'], output), 0); assert.match(text, /no account\/default profile/);
  text = ''; assert.equal(await main(['--unknown'], output), 1); assert.equal(JSON.parse(text).reason, 'invalid_options');
});

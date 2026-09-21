#!/usr/bin/env node
import { appendFileSync, existsSync, realpathSync, writeFileSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { isDirectRun } from '../adapters/direct-run.mjs';

const PREFIX = 'reflexmesh-claude-failure-';
const tool = { name: 'outcome', description: 'Synthetic read-only in-memory outcome fixture.',
  inputSchema: { type: 'object', properties: { mode: { type: 'string', enum: ['ok', 'fail'] } },
    required: ['mode'], additionalProperties: false },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: false } };

export function createFailureTools({ record, okText, failText, timeoutMs = 5000 }) {
  const entered = new Set();
  let release, timer, active = 0, closed = false;
  const barrier = new Promise(resolve => { release = resolve; });
  return {
    async handle(request) {
      if (!request || request.jsonrpc !== '2.0' || typeof request.method !== 'string') throw new Error('invalid_request');
      if (!Object.hasOwn(request, 'id')) {
        if (request.method !== 'notifications/initialized') throw new Error('invalid_notification');
        return undefined;
      }
      const reply = result => ({ jsonrpc: '2.0', id: request.id, result });
      if (request.method === 'initialize') return reply({ protocolVersion: request.params?.protocolVersion,
        capabilities: { tools: {} }, serverInfo: { name: 'reflexmesh-synthetic-outcomes', version: '1' } });
      if (request.method === 'ping') return reply({});
      if (request.method === 'tools/list') return reply({ tools: [tool] });
      const args = request.params?.arguments, mode = args?.mode;
      if (request.method !== 'tools/call' || request.params?.name !== 'outcome'
        || !args || Object.keys(args).join(',') !== 'mode' || !['ok', 'fail'].includes(mode)
        || entered.has(mode) || closed) throw new Error('invalid_call');
      entered.add(mode); active++;
      record({ event: 'entered', mode, active });
      timer ??= setTimeout(() => { closed = true; release(false); }, timeoutMs);
      if (entered.size === 2) { clearTimeout(timer); release(true); }
      const overlapping = await barrier;
      active--;
      record({ event: 'exited', mode, active, overlapping });
      if (!overlapping) return reply({ isError: true, content: [{ type: 'text', text: 'Synthetic fixture overlap failed' }] });
      return reply({ isError: mode === 'fail', content: [{ type: 'text', text: mode === 'fail' ? failText : okText }] });
    },
    close() { closed = true; clearTimeout(timer); release(false); },
  };
}

export async function main(argv = process.argv.slice(2), input = process.stdin, output = process.stdout) {
  const [receipt, okText, failText] = argv;
  if (argv.length !== 3 || ![okText, failText].every(text => /^SYNTHETIC_(OK|FAIL)_[a-z0-9-]{36}$/.test(text ?? ''))) return 1;
  const directory = realpathSync(dirname(receipt));
  if (!basename(directory).startsWith(PREFIX) || dirname(resolve(receipt)) !== directory
    || basename(receipt) !== 'tool-receipts.jsonl' || existsSync(receipt)) return 1;
  writeFileSync(receipt, '', { flag: 'wx', mode: 0o600 });
  const fixture = createFailureTools({ record: value => appendFileSync(receipt, JSON.stringify(value) + '\n'), okText, failText });
  const reader = createInterface({ input, crlfDelay: Infinity });
  const pending = new Set();
  let messages = 0, failed = false;
  try {
    for await (const line of reader) {
      if (++messages > 16 || Buffer.byteLength(line) > 65536) { failed = true; break; }
      let request;
      try { request = JSON.parse(line); } catch { failed = true; break; }
      const operation = fixture.handle(request).then(response => {
        if (response !== undefined) output.write(JSON.stringify(response) + '\n');
      }).catch(() => {
        failed = true;
        appendFileSync(receipt, JSON.stringify({ event: 'rejected' }) + '\n');
        output.write(JSON.stringify({ jsonrpc: '2.0', id: request?.id ?? null,
          error: { code: -32600, message: 'Synthetic fixture rejected request' } }) + '\n');
      });
      pending.add(operation); operation.finally(() => pending.delete(operation));
    }
  } finally {
    if (failed) appendFileSync(receipt, JSON.stringify({ event: 'failed' }) + '\n');
    reader.close(); fixture.close(); await Promise.all(pending);
  }
  return failed ? 1 : 0;
}
if (isDirectRun(import.meta.url)) {
  try { process.exitCode = await main(); } catch { process.exitCode = 1; }
}

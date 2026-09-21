#!/usr/bin/env node
import { createInterface } from 'node:readline';
import { isDirectRun } from '../adapters/direct-run.mjs';

export async function resumeToolMain(argv = process.argv.slice(2), input = process.stdin, output = process.stdout) {
  const [baseUrl, token, phaseText] = argv, phase = Number(phaseText);
  if (argv.length !== 3 || !/^http:\/\/127\.0\.0\.1:\d+$/.test(baseUrl ?? '') || !/^synthetic-[a-z0-9-]{36}$/.test(token ?? '') || !['1', '2'].includes(phaseText)) return 1;
  const reject = async () => {
    try { const response = await fetch(`${baseUrl}/fixture/rejected`, { method: 'POST', headers: { 'x-api-key': token, 'content-type': 'application/json' },
      body: '{}', redirect: 'error', signal: AbortSignal.timeout(2000) }); await response.arrayBuffer(); } catch {}
    return 1;
  };
  const reader = createInterface({ input, crlfDelay: Infinity });
  let count = 0, called = false;
  try {
    for await (const line of reader) {
      if (++count > 16 || Buffer.byteLength(line) > 65536) return await reject();
      const request = JSON.parse(line);
      if (request?.jsonrpc !== '2.0' || typeof request.method !== 'string') return await reject();
      if (!Object.hasOwn(request, 'id')) { if (request.method !== 'notifications/initialized') return await reject(); continue; }
      let result;
      if (request.method === 'initialize') result = { protocolVersion: request.params?.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'reflexmesh-synthetic-resume', version: '1' } };
      else if (request.method === 'ping') result = {};
      else if (request.method === 'tools/list') result = { tools: [{ name: 'read', description: 'Read the fixed in-memory synthetic fixture once.',
        inputSchema: { type: 'object', properties: { phase: { type: 'integer', enum: [1, 2] } }, required: ['phase'], additionalProperties: false },
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: false } }] };
      else {
        if (request.method !== 'tools/call' || request.params?.name !== 'read' || called
          || Object.keys(request.params.arguments ?? {}).join(',') !== 'phase' || request.params.arguments.phase !== phase) return await reject();
        called = true;
        const response = await fetch(`${baseUrl}/fixture/entered`, { method: 'POST', headers: { 'x-api-key': token, 'content-type': 'application/json' },
          body: JSON.stringify({ phase, pid: process.pid }), signal: AbortSignal.timeout(90000), redirect: 'error' });
        if (!response.ok) return await reject();
        const data = await response.json();
        if (typeof data.text !== 'string' || data.text.length > 1024) return await reject();
        result = { content: [{ type: 'text', text: data.text }], isError: false };
      }
      output.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }) + '\n');
    }
  } catch { return await reject(); } finally { reader.close(); }
  return 0;
}
if (isDirectRun(import.meta.url)) { try { process.exitCode = await resumeToolMain(); } catch { process.exitCode = 1; } }

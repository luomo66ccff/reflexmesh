#!/usr/bin/env node
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { record, validateCall } from '../dist/index.js';
import { jsonLines } from './stdio.mjs';
import { openLocalBoundary } from './local-config.mjs';

const callSchema = { type: 'object', additionalProperties: false,
  required: ['schemaVersion','harness','sessionId','agentId','callId','toolName','arguments'],
  properties: { schemaVersion: { const: 1 }, harness: { enum: ['codex','claude-code','deepseek-harness','openai-compatible'] },
    sessionId: { type: 'string', minLength: 1, maxLength: 256 }, agentId: { type: 'string', minLength: 1, maxLength: 256 },
    callId: { type: 'string', minLength: 1, maxLength: 256 }, toolName: { type: 'string', minLength: 1, maxLength: 256 }, arguments: {} } };
const schema = (properties, required) => ({ type: 'object', properties, required, additionalProperties: false });
const tools = [
  { name: 'reflexmesh_assess', description: 'Advisory shadow assessment. Records evidence only; never authorizes, blocks or executes a host tool.',
    inputSchema: schema({ call: callSchema, userIntent: { type: 'string', maxLength: 16000 } }, ['call']) },
  { name: 'reflexmesh_observe_outcome', description: 'Attach a MODEL-REPORTED outcome to an existing call. This is not verified execution evidence or a calibration truth label.',
    inputSchema: schema({ call: callSchema, status: { enum: ['succeeded','failed','unknown'] }, evidence: {} }, ['call','status','evidence']) },
  { name: 'reflexmesh_replay_policy', description: 'Pure counterfactual policy replay over an existing prediction, never reruns the model or tools. Candidate questions must match.',
    inputSchema: schema({ call: callSchema, candidatePack: { type: 'object' } }, ['call']) },
  { name: 'reflexmesh_inspect_pack', description: 'Read the installed decision contract, hash and shadow-only capabilities.', inputSchema: schema({}, []) },
];
const error = (id, code, message) => ({ jsonrpc: '2.0', id, error: { code, message } });
const ok = (id, result) => ({ jsonrpc: '2.0', id, result });
const textResult = value => ({ content: [{ type: 'text', text: JSON.stringify(value) }] });
/** Narrow 2025-06-18 STDIO tools profile; no HTTP, credentials, resources, sampling or execution proxy. */
export function createMcpHandler(boundary) {
  let initialized = false, ready = false;
  return async message => {
    if (!record(message) || message.jsonrpc !== '2.0' || typeof message.method !== 'string') return error(null, -32600, 'Invalid Request');
    const hasId = Object.hasOwn(message, 'id');
    if (hasId && !(typeof message.id === 'string' || Number.isSafeInteger(message.id))) return error(null, -32600, 'Invalid Request');
    if (!hasId) {
      if (message.method === 'notifications/initialized' && initialized) ready = true;
      return undefined;
    }
    const id = message.id;
    if (message.method === 'initialize') {
      if (initialized || !record(message.params) || typeof message.params.protocolVersion !== 'string') return error(id, -32602, 'Invalid initialization');
      initialized = true;
      return ok(id, { protocolVersion: '2025-06-18', capabilities: { tools: {} },
        serverInfo: { name: 'reflexmesh-shadow', version: '0.2.0-alpha.1' },
        instructions: 'Advisory shadow evidence only. Native tools are not intercepted; outcomes supplied here are model-reported, not ground truth.' });
    }
    if (!ready) return error(id, -32000, 'Initialization required');
    if (message.method === 'ping') return ok(id, {});
    if (message.method === 'tools/list') return ok(id, { tools });
    if (message.method !== 'tools/call') return error(id, -32601, 'Method not found');
    if (!record(message.params) || typeof message.params.name !== 'string') return error(id, -32602, 'Invalid tool request');
    const tool = tools.find(t => t.name === message.params.name);
    if (!tool) return error(id, -32602, 'Unknown tool');
    const args = message.params.arguments ?? {};
    if (!record(args) || Object.keys(args).some(k => !Object.hasOwn(tool.inputSchema.properties, k)) || tool.inputSchema.required.some(k => !Object.hasOwn(args, k))) return error(id, -32602, 'Invalid tool arguments');
    try {
      if (tool.name !== 'reflexmesh_inspect_pack') validateCall(args.call);
      let result;
      switch (tool.name) {
        case 'reflexmesh_assess': result = await boundary.before(args.call, args.userIntent ?? null); break;
        case 'reflexmesh_observe_outcome': result = await boundary.after(args.call, args.status, args.evidence, 'model-reported'); break;
        case 'reflexmesh_replay_policy': result = boundary.replay(args.call, args.candidatePack); break;
        default: result = boundary.inspectPack();
      }
      return ok(id, textResult(result));
    } catch { return ok(id, { ...textResult({ error: 'assessment_unavailable_or_contract_conflict', executionAllowed: false }), isError: true }); }
  };
}
export async function serve(input = process.stdin, output = process.stdout, errors = process.stderr, env = process.env) {
  let kernel;
  try {
    const opened = openLocalBoundary(env); kernel = opened.kernel;
    const handle = createMcpHandler(opened.boundary);
    for await (const line of jsonLines(input)) {
      let parsed;
      try { parsed = JSON.parse(line); } catch { output.write(JSON.stringify(error(null, -32700, 'Parse error')) + '\n'); continue; }
      const reply = await handle(parsed);
      if (reply) output.write(JSON.stringify(reply) + '\n');
    }
  } catch { errors.write('ReflexMesh STDIO stopped: invalid input or local configuration/storage unavailable.\n'); process.exitCode = 1; }
  finally { kernel?.close(); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await serve();

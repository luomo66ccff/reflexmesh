import { ReflexMesh, MockProvider, MemoryLedger, toolPreflightPack } from '../dist/index.js';
export function event(overrides = {}) {
  return { id: crypto.randomUUID(), type: 'tool.requested', source: 'test', tenantId: 't1', time: '2026-09-18T08:00:00.000Z', state: { intent: 'Read status.' }, ...overrides };
}
export const answers = { intentMatch: { type: 'noul', noul: 0.99 }, injection: { type: 'noul', noul: 0 } };
export const result = () => ({ model: 'fixture', answers: structuredClone(answers) });
export const requestOptions = () => ({ packId: 'tool-preflight', principal: { id: 'alice', tenantId: 't1' }, action: { toolId: 'read', args: {} } });
export function harness(options = {}) {
  const ledger = options.ledger ?? new MemoryLedger();
  const provider = options.provider ?? new MockProvider(result);
  const mesh = new ReflexMesh({ provider, ledger, ...options }).registerPack(toolPreflightPack);
  return { mesh, ledger, provider };
}
export const readTool = (execute = async () => ({ ok: true }), overrides = {}) => ({ id: 'read', effect: 'read', idempotent: true, speculatable: true, execute, ...overrides });

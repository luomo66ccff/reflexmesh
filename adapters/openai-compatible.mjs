import { fromOpenAICompatible } from '../dist/index.js';
/** Host-owned execution remains exactly where it was. Observer errors never trigger retries. */
export async function observeFunctionCall({ boundary, call, identity, execute, onError = () => {} }) {
  let normalized;
  const warn = () => { try { onError('reflexmesh_shadow_observation_failed'); } catch {} };
  try { normalized = fromOpenAICompatible(call, identity); await boundary.before(normalized); } catch { warn(); }
  let output;
  try { output = await execute(); }
  catch (original) {
    if (normalized) try { await boundary.after(normalized, 'unknown', { hostThrew: true }); } catch { warn(); }
    throw original; // A thrown body is not proof that no side effect occurred.
  }
  if (normalized) try { await boundary.after(normalized, 'succeeded', output); } catch { warn(); }
  return output;
}

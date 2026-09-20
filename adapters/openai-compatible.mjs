import { fromOpenAICompatible } from '../dist/index.js';
import { resolveHostIntent } from './task-evidence.mjs';
/** Host-owned execution remains exactly where it was. Observer errors never trigger retries. */
export async function observeFunctionCall({ boundary, call, identity, resolveIntent, execute, onError = () => {} }) {
  let normalized;
  const warn = () => { try { onError('reflexmesh_shadow_observation_failed'); } catch {} };
  try {
    normalized = fromOpenAICompatible(call, identity);
    const intent = resolveHostIntent(resolveIntent, normalized);
    await boundary.before(normalized, intent);
  } catch { warn(); }
  let output;
  try { output = await execute(); }
  catch (original) {
    if (normalized) try { await boundary.after(normalized, 'unknown', { hostThrew: true }); } catch { warn(); }
    throw original; // A thrown body is not proof that no side effect occurred.
  }
  if (normalized) try { await boundary.after(normalized, 'succeeded', output); } catch { warn(); }
  return output;
}

import { ContractError } from '../dist/index.js';

const CATALOG_URL = 'https://api.deepseek.com/models';
const CATALOG_BYTE_LIMIT = 65536;

/** An opt-in account-route preflight: one bounded GET, never a completion request. */
export async function requireListedDeepSeekModel({ apiKey, modelId, fetch = globalThis.fetch, signal }) {
  if (typeof apiKey !== 'string' || !apiKey.trim() || /[\r\n]/.test(apiKey))
    throw new ContractError('Missing or invalid DeepSeek API key; no evaluation request or output opened');
  if (typeof modelId !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/.test(modelId))
    throw new ContractError('Explicit valid DeepSeek model required; no evaluation request or output opened');
  if (typeof fetch !== 'function') throw new ContractError('DeepSeek model catalog unavailable; no evaluation request or output opened');
  const requestSignal = signal ? AbortSignal.any([signal, AbortSignal.timeout(10000)]) : AbortSignal.timeout(10000);
  let response;
  try {
    requestSignal.throwIfAborted();
    response = await fetch(CATALOG_URL, { method: 'GET', redirect: 'error', signal: requestSignal,
      headers: { Authorization: `Bearer ${apiKey.trim()}`, Accept: 'application/json' } });
  } catch { throw new ContractError('DeepSeek model catalog unavailable; no evaluation request or output opened'); }
  if (response.status !== 200) {
    await response.body?.cancel().catch(() => {});
    throw new ContractError('DeepSeek model catalog rejected the request; no evaluation request or output opened');
  }
  const reader = response.body?.getReader();
  if (!reader) throw new ContractError('DeepSeek model catalog invalid; no evaluation request or output opened');
  const decoder = new TextDecoder('utf-8', { fatal: true });
  const abort = () => { void reader.cancel().catch(() => {}); };
  requestSignal.addEventListener('abort', abort, { once: true });
  let text = '', bytes = 0;
  try {
    while (true) {
      requestSignal.throwIfAborted();
      const part = await reader.read();
      if (part.done) break;
      bytes += part.value.byteLength;
      if (bytes > CATALOG_BYTE_LIMIT) throw new Error('catalog_too_large');
      text += decoder.decode(part.value, { stream: true });
    }
    text += decoder.decode();
    requestSignal.throwIfAborted();
  } catch {
    await reader.cancel().catch(() => {});
    throw new ContractError('DeepSeek model catalog invalid or unavailable; no evaluation request or output opened');
  } finally { requestSignal.removeEventListener('abort', abort); reader.releaseLock(); }
  let catalog;
  try { catalog = JSON.parse(text); } catch {
    throw new ContractError('DeepSeek model catalog invalid; no evaluation request or output opened');
  }
  if (catalog?.object !== 'list' || !Array.isArray(catalog.data)
    || !catalog.data.every(item => item && item.object === 'model'
      && typeof item.id === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/.test(item.id)))
    throw new ContractError('DeepSeek model catalog invalid; no evaluation request or output opened');
  if (!catalog.data.some(item => item.id === modelId))
    throw new ContractError('Selected DeepSeek model is not listed for this account; no evaluation request or output opened');
  return true;
}

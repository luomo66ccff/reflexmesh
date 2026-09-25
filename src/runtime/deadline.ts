import { ContractError } from '../core/validation.js';

const MAX_TIMER_DELAY_MS = 2_147_483_647;

/** Node truncates fractional delays and turns out-of-range delays into 1 ms. */
export function assertDeadlineMs(value: unknown, name: string): asserts value is number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)
    || value < 1 || value > MAX_TIMER_DELAY_MS) {
    throw new ContractError(`Invalid ${name}: expected integer milliseconds from 1 to ${MAX_TIMER_DELAY_MS}`);
  }
}

/** Bounds waiting even if an adapter ignores its signal. Cancellation cannot undo side effects. */
export async function withDeadline<T>(milliseconds: number, fn: (signal: AbortSignal) => Promise<T>): Promise<T> {
  assertDeadlineMs(milliseconds, 'deadline');
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => { controller.abort(); reject(new Error('Deadline exceeded')); }, milliseconds);
  });
  try { return await Promise.race([Promise.resolve().then(() => fn(controller.signal)), timeout]); }
  finally { if (timer !== undefined) clearTimeout(timer); }
}

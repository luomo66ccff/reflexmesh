/** Bounds waiting even if an adapter ignores its signal. Cancellation cannot undo side effects. */
export async function withDeadline<T>(milliseconds: number, fn: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => { controller.abort(); reject(new Error('Deadline exceeded')); }, milliseconds);
  });
  try { return await Promise.race([Promise.resolve().then(() => fn(controller.signal)), timeout]); }
  finally { if (timer !== undefined) clearTimeout(timer); }
}

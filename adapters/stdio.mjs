import { TextDecoder } from 'node:util';

/** MCP STDIO: one UTF-8 JSON-RPC message per line, with a bounded pending frame. */
export async function* jsonLines(input, limit = 262144) {
  let pending = Buffer.alloc(0);
  const decoder = new TextDecoder('utf-8', { fatal: true });
  for await (const chunk of input) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    let start = 0, newline;
    while ((newline = bytes.indexOf(10, start)) !== -1) {
      const part = bytes.subarray(start, newline);
      if (pending.length + part.length > limit) throw new Error('Frame exceeds limit');
      const frame = pending.length ? Buffer.concat([pending, part]) : part;
      pending = Buffer.alloc(0);
      yield decoder.decode(frame);
      start = newline + 1;
    }
    const rest = bytes.subarray(start);
    if (pending.length + rest.length > limit) throw new Error('Frame exceeds limit');
    if (rest.length) pending = pending.length ? Buffer.concat([pending, rest]) : Buffer.from(rest);
  }
  if (pending.length) throw new Error('Incomplete STDIO frame');
}

/** Claude hooks send one JSON object followed by EOF, not a persistent protocol session. */
export async function oneJson(input, limit = 262144, timeoutMs = 3000) {
  const chunks = []; let size = 0;
  const timer = setTimeout(() => input.destroy(new Error('Input deadline')), timeoutMs);
  try {
    for await (const chunk of input) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += bytes.length;
      if (size > limit) throw new Error('Input exceeds limit');
      chunks.push(bytes);
    }
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)));
  } finally { clearTimeout(timer); }
}

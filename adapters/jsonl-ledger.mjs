import { open, readFile } from 'node:fs/promises';

/** Local single-process audit sink; fsync per record. Not a distributed WAL or an authorization boundary. */
export class JsonlLedger {
  #path;
  #tail = Promise.resolve();
  constructor(path) { this.#path = path; }
  append(record) {
    // Snapshot BEFORE queueing to prevent caller mutation while waiting for earlier writes.
    const line = JSON.stringify(record) + '\n';
    this.#tail = this.#tail.then(async () => {
      const handle = await open(this.#path, 'a', 0o600);
      try { await handle.writeFile(line, 'utf8'); await handle.sync(); }
      finally { await handle.close(); }
    });
    return this.#tail; // A failed sink stays failed: do not proceed silently.
  }
}
export async function readLedger(path) {
  const text = await readFile(path, 'utf8');
  return text.split('\n').filter(Boolean).map((line, index) => {
    try {
      const row = JSON.parse(line);
      if (!row || typeof row.eventId !== 'string' || typeof row.kind !== 'string') throw new Error();
      return row;
    } catch { throw new Error(`Invalid audit row ${index + 1}`); }
  });
}

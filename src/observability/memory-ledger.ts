import type { AuditRecord, Ledger } from '../core/types.js';
import { snapshot } from '../core/validation.js';
export class MemoryLedger implements Ledger {
  readonly #records: AuditRecord[] = [];
  async append(record: AuditRecord): Promise<void> { this.#records.push(snapshot(record)); }
  list(): readonly AuditRecord[] { return snapshot(this.#records); }
}

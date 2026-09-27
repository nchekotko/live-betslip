import type { AuditAction, AuditEntry } from '@live-betslip/protocol';

/** Append-only in-memory audit trail (bounded). Newest entries first on read. */
export class AuditLog {
  private readonly entries: AuditEntry[] = [];
  private counter = 0;

  constructor(
    private readonly now: () => number,
    private readonly capacity = 2000,
  ) {}

  append(entry: { actor: string; action: AuditAction; marketIds: string[]; reason: string }): AuditEntry {
    this.counter += 1;
    const full: AuditEntry = { id: `audit-${this.counter}`, ts: Math.floor(this.now()), ...entry };
    this.entries.push(full);
    if (this.entries.length > this.capacity) this.entries.shift();
    return full;
  }

  list(limit = 200, filter?: { actor?: string; action?: AuditAction }): AuditEntry[] {
    const out: AuditEntry[] = [];
    for (let i = this.entries.length - 1; i >= 0 && out.length < limit; i--) {
      const e = this.entries[i];
      if (!e) continue;
      if (filter?.actor && e.actor !== filter.actor) continue;
      if (filter?.action && e.action !== filter.action) continue;
      out.push(e);
    }
    return out;
  }
}

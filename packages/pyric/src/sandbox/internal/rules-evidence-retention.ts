import type { SandboxEvent } from '../types/events.js';

/** Track retained entries by identity so history eviction cannot shift the owner. */
export class RulesEvidenceRetention<Entry extends { event: SandboxEvent }> {
  private readonly entries = new Set<Entry>();

  record(entry: Entry): Entry | undefined {
    const event = entry.event;
    const hasEvidence = event.kind === 'request' && event.rulesEvidence !== undefined;
    const hasNoEvidence = !hasEvidence;
    if (hasNoEvidence) return;
    this.entries.add(entry);
    const withinLimit = this.entries.size <= 64;
    if (withinLimit) return;
    const oldest = this.entries.values().next().value;
    const hasOldest = oldest !== undefined;
    if (hasOldest) this.entries.delete(oldest);
    return oldest;
  }

  forget(entry: Entry): void {
    this.entries.delete(entry);
  }

  clear(): void {
    this.entries.clear();
  }
}

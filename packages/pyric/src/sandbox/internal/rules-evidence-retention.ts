import type { SandboxEvent } from '../types/events.js';

/** Keep request metadata indefinitely, but only the latest 64 evaluation snapshots.
 * Replace history entries on expiry so existing consumer snapshots remain valid.
 */
export class RulesEvidenceRetention {
  private indices: number[] = [];

  record(history: SandboxEvent[], index: number): void {
    const event = history[index];
    if (event?.kind !== 'request' || event.rulesEvidence === undefined) return;
    this.indices.push(index);
    if (this.indices.length <= 64) return;
    const expiredIndex = this.indices.shift();
    if (expiredIndex === undefined) return;
    const expired = history[expiredIndex];
    if (expired?.kind !== 'request') return;
    const { rulesEvidence, ...metadata } = expired;
    history[expiredIndex] = { ...metadata, rulesEvidenceExpired: true };
  }

  clear(): void {
    this.indices = [];
  }
}

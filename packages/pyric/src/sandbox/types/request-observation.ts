import type { AiEvidence } from '../internal/ai-evidence.js';

/** A cumulative execution snapshot. Its request ID survives lifecycle updates. */
export interface RequestObservation {
  readonly id: string;
  readonly startedAt: number;
  readonly endedAt?: number;
  readonly status: 'pending' | 'completed' | 'failed' | 'cancelled' | 'interrupted';
  readonly ai?: AiEvidence;
  readonly response?: { readonly text: string; readonly truncated: boolean };
  readonly error?: { readonly code: string };
}

/** Consistent execution labels for retained host and page observations. */
export function requestStatusLabel(status: string): string {
  switch (status) {
    case 'pending': return 'In progress';
    case 'completed': return 'Completed';
    case 'failed': return 'Failed';
    case 'cancelled': return 'Cancelled';
    case 'interrupted': return 'Interrupted';
    case 'closed': return 'Closed';
    default: return 'Not recorded';
  }
}

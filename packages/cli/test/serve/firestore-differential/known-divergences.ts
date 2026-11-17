/**
 * Pinned cross-plane divergences that are each locked by separate upstream
 * tests:
 *
 * - `errored-listener-rules-reload`: in-process `setRules` (`deployRules`)
 *   re-evaluates errored listeners on rules hot-reload (`74fb670ea` item 4,
 *   `rules-flip.test.ts`), whereas the served worker host purges errored
 *   subscriptions permanently on `permission-denied`
 *   (`cross-plane-wire-and-revocation.test.ts`). Both planes must still agree
 *   on every event up to and including the `permission-denied` error.
 *
 * Every entry here must be reproduced by a fixture under `fixtures/`; `--strict`
 * reports them as mismatches as well.
 */

import { stableJson, type Mismatch } from './compare.js';
import type { Sequence } from './sequence.js';

export interface KnownDivergence {
  name: string;
  matches(mismatch: Mismatch, sequence: Sequence): boolean;
}

interface ListenerErrorEvent {
  kind?: unknown;
  error?: unknown;
}

function isPermissionDeniedErrorEvent(event: unknown): boolean {
  if (event === null || typeof event !== 'object') {
    return false;
  }
  const candidate = event as ListenerErrorEvent;
  return candidate.kind === 'error' && candidate.error === 'code=permission-denied';
}

function hasActiveRulesReloadForListener(sequence: Sequence, listenerId: number): boolean {
  let attached = false;
  for (const step of sequence.steps) {
    if ((step.op === 'listenDoc' || step.op === 'listenQuery') && step.id === listenerId) {
      attached = true;
      continue;
    }
    if (attached && step.op === 'unlisten' && step.id === listenerId) {
      return false;
    }
    if (attached && step.op === 'rules') {
      return true;
    }
  }
  return false;
}

export const KNOWN_DIVERGENCES: readonly KnownDivergence[] = [
  {
    name: 'errored-listener-rules-reload',
    matches(mismatch: Mismatch, sequence: Sequence): boolean {
      const idMatch = /^events\.L(\d+)\b/.exec(mismatch.where);
      if (idMatch === null) {
        return false;
      }
      const listenerId = Number(idMatch[1]);
      if (!hasActiveRulesReloadForListener(sequence, listenerId)) {
        return false;
      }
      const sandboxEvents = mismatch.values['sandbox'];
      const hostedEvents = mismatch.values['hosted'];
      if (!Array.isArray(sandboxEvents) || !Array.isArray(hostedEvents)) {
        return false;
      }
      if (hostedEvents.length === 0 || sandboxEvents.length <= hostedEvents.length) {
        return false;
      }
      const lastHosted = hostedEvents[hostedEvents.length - 1];
      if (!isPermissionDeniedErrorEvent(lastHosted)) {
        return false;
      }
      const sandboxPrefix = sandboxEvents.slice(0, hostedEvents.length);
      return stableJson(sandboxPrefix) === stableJson(hostedEvents);
    },
  },
];

export function knownDivergence(
  mismatch: Mismatch,
  sequence: Sequence,
): KnownDivergence | undefined {
  return KNOWN_DIVERGENCES.find((entry) => entry.matches(mismatch, sequence));
}

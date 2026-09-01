import type { SandboxEvent } from 'pyric/sandbox';

/**
 * AI broker rejection relay — headless dev visibility for `request_rejected`.
 *
 * The broker lands a `service_mutation` event (`service: 'ai'`, `op:
 * 'request_rejected'`) on the sandbox's unified stream every time it refuses
 * a request — a bad role, empty `contents`, a missing thought signature, or
 * an engine that answered an error envelope. That stream is browser-side: the
 * worker host fans it out over the port for Studio, and it never reaches the
 * dev server. An agent driving `pyric dev` headlessly therefore saw NOTHING
 * when the broker rejected.
 *
 * This is the AI twin of the Firebase Activity Guard reporter next door
 * (`activity-guard.ts`): a browser-safe subscriber shared by the SharedWorker
 * and in-page planes, which fire-and-forget POSTs to the dev server. It rides
 * the DENIAL relay's existing channel (`POST /__pyric/denials` — see the
 * denial relay section of `namespace.ts`) rather than opening a new one: a
 * broker rejection is the same category of thing as a rules denial ("the
 * sandbox refused your operation"), it wants the same terminal treatment, and
 * it wants that endpoint's per-(target, message) throttle — an agent retry
 * loop re-sends the same malformed request over and over.
 *
 * Best-effort, exactly like the activity reporter and the denial relay: never
 * throws, never awaited into app flow, and a relay failure (dev server gone,
 * no `fetch`, non-pyric host) is swallowed. Diagnostics, not a correctness
 * path.
 */

/** The slice of the sandbox this relay needs. Live events only — replaying
 *  `history()` on boot would re-announce rejections the terminal already
 *  printed (and the activity feed's reason for taking history does not apply:
 *  nothing here correlates across events). */
export interface AiRejectionFeed {
  subscribe(listener: (event: SandboxEvent) => void): unknown;
}

/** Shape POSTed to the dev server's `/__pyric/denials` endpoint. The `kind`
 *  discriminates it from the rules-denial payload the same route accepts.
 *  `namespace.ts` mirrors this loosely (`AiRejectionPayload`) — it reads the
 *  body defensively rather than importing this browser-side module. */
interface AiRejectionRelayPayload {
  kind: 'ai-rejection';
  /** Model resource the rejected op targeted (the event's `path`). */
  model?: string;
  /** Which engine the broker resolved to (`scripted` | `openai` | `gemini` |
   *  `custom`) — a rejection reads very differently for each. */
  engine?: string;
  /** Wire error status (e.g. `INVALID_ARGUMENT`) and HTTP-ish code. */
  status?: string;
  code?: number;
  /** The rejection reason — production's own message for shape errors. */
  message: string;
}

/** Narrow a sandbox event to a broker rejection, defensively: `detail` is a
 *  free-form record on the event contract, so every field is re-checked. */
function toRejectionPayload(event: SandboxEvent): AiRejectionRelayPayload | null {
  if (event.kind !== 'service_mutation') return null;
  if (event.service !== 'ai' || event.op !== 'request_rejected') return null;
  const detail = (event.detail ?? {}) as Record<string, unknown>;
  return {
    kind: 'ai-rejection',
    ...(typeof event.path === 'string' && event.path !== '' ? { model: event.path } : {}),
    ...(typeof detail.engine === 'string' ? { engine: detail.engine } : {}),
    ...(typeof detail.status === 'string' ? { status: detail.status } : {}),
    ...(typeof detail.code === 'number' ? { code: detail.code } : {}),
    message: typeof detail.message === 'string' ? detail.message : 'request rejected',
  };
}

/**
 * Subscribe to the sandbox event stream and relay every broker rejection to
 * the dev server for terminal visibility. Browser-safe (shared by the
 * SharedWorker host and the in-page runtime); returns nothing to unsubscribe
 * with, mirroring the guard next door — the subscription is observational and
 * lives for the plane's lifetime.
 */
export function setupAiRejectionRelay(feed: AiRejectionFeed, fetchFn: typeof fetch): void {
  feed.subscribe((event) => {
    const payload = toRejectionPayload(event);
    if (payload === null) return;
    try {
      void fetchFn('/__pyric/denials', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      }).catch(() => {
        /* Diagnostics are best-effort and must never affect app behavior. */
      });
    } catch {
      /* An injected or unavailable fetch must never affect app behavior. */
    }
  });
}

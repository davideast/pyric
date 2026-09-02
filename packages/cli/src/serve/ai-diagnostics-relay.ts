import type { SandboxEvent } from 'pyric/sandbox';

/**
 * AI diagnostics relay: headless dev visibility for the three things the
 * broker does that no app-level signal reports.
 *
 * The broker lands `service_mutation` events (`service: 'ai'`) on the
 * sandbox's unified stream. That stream is browser-side: the worker host fans
 * it out over the port for Studio, and it never reaches the dev server. An
 * agent driving `pyric dev` headlessly therefore saw NOTHING.
 *
 *   - `request_rejected`: a bad role, empty `contents`, a missing thought
 *     signature, or an engine that answered an error envelope.
 *   - `response_blocked`: the SILENT refusal. A safety / recitation /
 *     blocklist filter answers HTTP 200 with an empty candidate, so nothing
 *     throws anywhere and the app simply renders nothing.
 *   - `model_substituted`: not a refusal at all. The answer arrives, from a
 *     model the developer never asked for (an openai `modelMap` entry or
 *     catch-all `model`, a gemini experimental alias). Same shape of problem:
 *     the sandbox quietly did something other than what the code said, and
 *     only the terminal can say so.
 *
 * One record per kind in {@link AI_DIAGNOSTIC_RELAYS} pairs the sandbox `op`
 * with the narrower that turns it into a wire payload. The terminal formatter
 * and throttle key for each kind live in `ai-terminal-blocks.ts`, keyed by the
 * same {@link AiDiagnosticKind} union, so the compiler flags a kind that is
 * relayed but never rendered.
 *
 * This is the AI twin of the Firebase Activity Guard reporter next door
 * (`activity-guard.ts`): a browser-safe subscriber shared by the SharedWorker
 * and in-page planes, which fire-and-forget POSTs to the dev server. It rides
 * the DENIAL relay's existing channel (`POST /__pyric/denials`, see the denial
 * relay section of `namespace.ts`) rather than opening a new one: a broker
 * refusal is the same category of thing as a rules denial, it wants the same
 * terminal treatment, and it wants that endpoint's per-(target, reason)
 * throttle, because an agent retry loop re-sends the same request over and
 * over.
 *
 * Best-effort, exactly like the activity reporter and the denial relay: never
 * throws, never awaited into app flow, and a relay failure (dev server gone,
 * no `fetch`, non-pyric host) is swallowed. Diagnostics, not a correctness
 * path.
 */

/** The slice of the sandbox this relay needs. Live events only: replaying
 *  `history()` on boot would re-announce refusals the terminal already
 *  printed (and the activity feed's reason for taking history does not apply,
 *  since nothing here correlates across events). */
export interface AiDiagnosticsFeed {
  subscribe(listener: (event: SandboxEvent) => void): unknown;
}

/** The `kind` discriminator on every payload this relay POSTs. It is also the
 *  key of the formatter table in `ai-terminal-blocks.ts`. */
export type AiDiagnosticKind = 'ai-rejection' | 'ai-blocked' | 'ai-model-substituted';

/** The sandbox events this relay reads. */
type ServiceMutation = Extract<SandboxEvent, { kind: 'service_mutation' }>;

/** Shape POSTed for a `request_rejected` event. `namespace.ts` reads it back
 *  loosely (`AiRejectionPayload` in `ai-terminal-blocks.ts`): the body is JSON
 *  from the served page, and nothing on the far side enforces this type. */
interface AiRejectionRelayPayload {
  kind: 'ai-rejection';
  /** Model resource the rejected op targeted (the event's `path`). */
  model?: string;
  /** Which engine the broker resolved to (`scripted` | `openai` | `gemini` |
   *  `custom`); a rejection reads very differently for each. */
  engine?: string;
  /** Wire error status (e.g. `INVALID_ARGUMENT`) and HTTP-ish code. */
  status?: string;
  code?: number;
  /** The rejection reason: production's own message for shape errors. */
  message: string;
}

/** Shape POSTed for a `response_blocked` event. Carries the wire's own
 *  vocabulary, `finishReason` (a candidate was withheld) or `blockReason`
 *  (the prompt was refused), rather than a pre-rendered sentence, so the
 *  terminal formatter owns the phrasing exactly the way it does for a
 *  rejection. */
interface AiBlockedRelayPayload {
  kind: 'ai-blocked';
  /** Model resource the blocked op targeted (the event's `path`). */
  model?: string;
  /** Which engine the broker resolved to. */
  engine?: string;
  /** Candidate-level block: `SAFETY`, `RECITATION`, `BLOCKLIST`, and so on. */
  finishReason?: string;
  /** Production's own explanatory text for the block, when it sent one. */
  finishMessage?: string;
  /** Prompt-level block: `promptFeedback.blockReason`. */
  blockReason?: string;
}

/** Shape POSTed for a `model_substituted` event. Not a refusal: the answer
 *  arrives normally, just from a model the developer never named. */
interface AiModelSubstitutionRelayPayload {
  kind: 'ai-model-substituted';
  /** The model the request asked for (the event's `path`). */
  requestedModel: string;
  /** The model the engine actually calls (bare, no `models/` prefix). */
  effectiveModel: string;
  /** Which engine substituted (`openai` | `gemini` | ...). */
  engine?: string;
  /** Why it differs, e.g. `engine modelMap`, `experimental alias`. */
  reason?: string;
}

type AiDiagnosticRelayPayload =
  | AiRejectionRelayPayload
  | AiBlockedRelayPayload
  | AiModelSubstitutionRelayPayload;

/** A string field off the event's free-form `detail` record, or `undefined`
 *  when the emitter did not set it. `detail` is a public contract anyone can
 *  post onto, so every field is re-checked. */
function detailText(detail: Record<string, unknown>, field: string): string | undefined {
  const value = detail[field];
  if (typeof value !== 'string') return undefined;
  return value;
}

/** The event's `path` when it names a model, or `undefined`. */
function eventModel(event: ServiceMutation): string | undefined {
  if (typeof event.path !== 'string' || event.path === '') return undefined;
  return event.path;
}

function detailOf(event: ServiceMutation): Record<string, unknown> {
  return (event.detail ?? {}) as Record<string, unknown>;
}

/** Narrow a `request_rejected` event to its relay payload. */
function toRejectionPayload(event: ServiceMutation): AiRejectionRelayPayload | null {
  const detail = detailOf(event);
  const payload: AiRejectionRelayPayload = {
    kind: 'ai-rejection',
    message: detailText(detail, 'message') ?? 'request rejected',
  };
  payload.model = eventModel(event);
  payload.engine = detailText(detail, 'engine');
  payload.status = detailText(detail, 'status');
  if (typeof detail.code === 'number') payload.code = detail.code;
  return payload;
}

/** Narrow a `response_blocked` event to its relay payload. */
function toBlockedPayload(event: ServiceMutation): AiBlockedRelayPayload | null {
  const detail = detailOf(event);
  const payload: AiBlockedRelayPayload = { kind: 'ai-blocked' };
  payload.model = eventModel(event);
  payload.engine = detailText(detail, 'engine');
  payload.finishReason = detailText(detail, 'finishReason');
  payload.finishMessage = detailText(detail, 'finishMessage');
  payload.blockReason = detailText(detail, 'blockReason');
  return payload;
}

/**
 * Narrow a `model_substituted` event to its relay payload, and enforce the
 * invariant the terminal line depends on: an effective model equal to the
 * requested one is NOT a substitution and never relays. The broker already
 * compares before emitting; this re-checks because the event stream is a
 * public contract anyone can post onto.
 */
function toModelSubstitutionPayload(
  event: ServiceMutation,
): AiModelSubstitutionRelayPayload | null {
  const detail = detailOf(event);
  const requestedModel = detailText(detail, 'requestedModel') ?? eventModel(event) ?? '';
  const effectiveModel = detailText(detail, 'effectiveModel') ?? '';
  if (requestedModel === '' || effectiveModel === '') return null;
  let requestedBare = requestedModel;
  if (requestedModel.startsWith('models/')) requestedBare = requestedModel.slice('models/'.length);
  if (effectiveModel === requestedBare || effectiveModel === requestedModel) return null;
  const payload: AiModelSubstitutionRelayPayload = {
    kind: 'ai-model-substituted',
    requestedModel,
    effectiveModel,
  };
  payload.engine = detailText(detail, 'engine');
  payload.reason = detailText(detail, 'reason');
  return payload;
}

/** One record per relayed kind: the sandbox `op` that produces it, and the
 *  narrower that turns that event into a wire payload. */
interface AiDiagnosticRelay {
  op: string;
  fromEvent(event: ServiceMutation): AiDiagnosticRelayPayload | null;
}

const AI_DIAGNOSTIC_RELAYS: { [K in AiDiagnosticKind]: AiDiagnosticRelay } = {
  'ai-rejection': { op: 'request_rejected', fromEvent: toRejectionPayload },
  'ai-blocked': { op: 'response_blocked', fromEvent: toBlockedPayload },
  'ai-model-substituted': { op: 'model_substituted', fromEvent: toModelSubstitutionPayload },
};

/** The relay record for a sandbox `op`, or `null` for an op nothing relays. */
function relayForOp(op: string): AiDiagnosticRelay | null {
  for (const relay of Object.values(AI_DIAGNOSTIC_RELAYS)) {
    if (relay.op === op) return relay;
  }
  return null;
}

/**
 * Subscribe to the sandbox event stream and relay every broker refusal,
 * rejected request or blocked response, plus every silent model substitution,
 * to the dev server for terminal visibility.
 *
 * Browser-safe (shared by the SharedWorker host and the in-page runtime);
 * returns nothing to unsubscribe with, mirroring the guard next door, since
 * the subscription is observational and lives for the plane's lifetime.
 */
export function setupAiDiagnosticsRelay(feed: AiDiagnosticsFeed, fetchFn: typeof fetch): void {
  feed.subscribe((event) => {
    if (event.kind !== 'service_mutation') return;
    if (event.service !== 'ai') return;
    const relay = relayForOp(event.op);
    if (relay === null) return;
    const payload = relay.fromEvent(event);
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

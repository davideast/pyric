/**
 * AI ops over the worker port — the served firebase/ai entry plugs these in
 * as the mirror AnswerEngine on the worker path (see entries/ai.ts).
 */

import type { AiEngineConfigWire, InboundMessage } from '../protocol.js';
import { nextId, nextSubId, rpc, _snapSubs } from './core.js';
import type { ClientDb } from './handles.js';

// ─── AI ops (pyric/ai over the worker — cdd-deltas #98.3) ──────────────────
//
// The served `firebase/ai` entry (entries/ai.ts) plugs these three functions
// in as the mirror's AnswerEngine on the worker path, so the page keeps the
// full `pyric/ai` surface (GenerativeModel / ChatSession / Schema) while
// ANSWERING happens in the worker host's broker — in-process with the ONE
// shared sandbox (#98.1), whose unified event stream Studio consumes.
// Requests/responses are the plain Gemini-wire JSON the broker speaks; no
// codec round-trip. `engine` rides each message but is honored only on the
// worker's FIRST ai op (broker creation — see AiEngineConfigWire).

/** Parameters shared by the three AI ops. */
export interface AiOpParams {
  /** Model resource the mirror resolved (e.g. `models/gemini-flash-lite-latest`). */
  model: string;
  /** Plain Gemini-wire request JSON. */
  request: Record<string, unknown>;
  /** First-op engine config — see {@link AiEngineConfigWire}. */
  engine?: AiEngineConfigWire;
}

/** Unary `generateContent` against the worker's broker. Resolves with the
 *  complete WireResponse envelope; rejects with an Error carrying `.code`
 *  (and `.aiEnvelope` when the broker answered a wire error envelope). */
export async function aiGenerateContent(
  db: ClientDb,
  params: AiOpParams,
): Promise<Record<string, unknown>> {
  return (await rpc(db.port, {
    t: 'op',
    id: nextId(),
    method: 'ai.generateContent',
    model: params.model,
    request: params.request,
    ...(params.engine !== undefined ? { engine: params.engine } : {}),
  })) as Record<string, unknown>;
}

/** Unary `countTokens` against the worker's broker (deterministic). */
export async function aiCountTokens(
  db: ClientDb,
  params: AiOpParams,
): Promise<Record<string, unknown>> {
  return (await rpc(db.port, {
    t: 'op',
    id: nextId(),
    method: 'ai.countTokens',
    model: params.model,
    request: params.request,
    ...(params.engine !== undefined ? { engine: params.engine } : {}),
  })) as Record<string, unknown>;
}

/**
 * Streamed `generateContent` over an AI stream SUBSCRIPTION: chunks arrive
 * as `{ chunk }` snaps in order, the terminal `{ done: true }` snap ends the
 * iteration, and a snap `__error` throws (with `.code` / `.aiEnvelope`).
 * The host auto-unsubs on done; the generator additionally sends `unsub` on
 * teardown so early consumer abandonment cancels the worker-side pump (the
 * done/unsub race is a benign no-op on the host).
 */
export async function* aiStreamGenerateContent(
  db: ClientDb,
  params: AiOpParams,
): AsyncGenerator<Record<string, unknown>> {
  const subId = nextSubId();
  type QueueItem =
    | { kind: 'chunk'; chunk: Record<string, unknown> }
    | { kind: 'done' }
    | { kind: 'error'; error: unknown };
  const queue: QueueItem[] = [];
  let notify: (() => void) | null = null;
  const push = (item: QueueItem): void => {
    queue.push(item);
    notify?.();
    notify = null;
  };

  _snapSubs.set(subId, {
    next: (raw) => {
      const v = (raw ?? {}) as { chunk?: Record<string, unknown>; done?: boolean };
      if (v.done) push({ kind: 'done' });
      else push({ kind: 'chunk', chunk: v.chunk ?? {} });
    },
    error: (err) => push({ kind: 'error', error: err }),
  });

  db.port.postMessage({
    t: 'sub',
    subId,
    target: { service: 'ai', op: 'streamGenerateContent' },
    model: params.model,
    request: params.request,
    ...(params.engine !== undefined ? { engine: params.engine } : {}),
  } satisfies InboundMessage);

  try {
    for (;;) {
      while (queue.length === 0) {
        await new Promise<void>((resolve) => {
          notify = resolve;
        });
      }
      const item = queue.shift()!;
      if (item.kind === 'error') throw item.error;
      if (item.kind === 'done') return;
      yield item.chunk;
    }
  } finally {
    _snapSubs.delete(subId);
    db.port.postMessage({ t: 'unsub', subId } satisfies InboundMessage);
  }
}

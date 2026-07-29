/**
 * SharedWorker host — AI op + stream-subscription handlers (pyric/ai).
 *
 * Implements cdd-deltas "Where the engines live under pyric dev (#98)":
 *
 *   1. The broker and engines run IN-PROCESS with the sandbox — here, in the
 *      worker host. The scripted engine does no I/O anywhere.
 *   2. The openai engine's default base URL in this (browser) context is the
 *      same-origin `/__pyric/ai-proxy` route, so a localhost upstream (Ollama)
 *      needs no CORS setup. Relative URLs resolve against the worker script's
 *      origin, so the plain path works from inside the SharedWorker.
 *   3. `ai.generateContent` / `ai.countTokens` are unary ops exactly like
 *      `rtdb.*` / `auth.*`; `ai.streamGenerateContent` is a FINITE
 *      subscription that delivers `{ chunk }` snaps in order, then a terminal
 *      `{ done: true }` snap and auto-unsubscribes (see AiStreamSubMessage).
 *   4. Engine choice + model mapping are per-sandbox config: the broker is
 *      recovered from `getAI(ctx.sandbox, …)` (the mirror's OWN per-sandbox
 *      broker — its events land on the shared sandbox's unified stream), and
 *      is created ONCE — host config (`ctx.aiEngine`) wins over the first
 *      op's `engine` field; later configs are ignored, mirroring `getAI`'s
 *      first-call-wins idempotence.
 *
 * Decomposition mirrors host-auth.ts / host-events.ts: host.ts routes
 * `ai.*` ops and `{ service: 'ai' }` subs here; this module never imports
 * host.ts (no cycles — it leans only on the host-context foundation).
 */

import { getAI, TARGET_SYMBOL, type AIOptions } from 'pyric/ai';

import { serializeError, type OpMessage, type AiStreamSubMessage, type AiEngineConfigWire } from './protocol.js';
import { type HostCtx, type PortLike, type AiBrokerLike, post, ok, fail } from './host-context.js';

/** The serve proxy route the browser openai engine defaults to (#98.2). */
export const AI_PROXY_PATH = '/__pyric/ai-proxy';

/** Is this op an AI op (routed here instead of handleOp)? */
export function isAiOp(method: OpMessage['method']): boolean {
  return method.startsWith('ai.');
}

/** The two unary AI op variants, extracted from the OpMessage union. */
type AiOpMessage = Extract<OpMessage, { method: 'ai.generateContent' | 'ai.countTokens' }>;

/**
 * Wire config → the mirror's `EngineConfig`. The only transformation is the
 * browser default: an openai config with no `baseUrl` targets the serve
 * proxy path. Script entries pass through as-is (they are the broker's own
 * plain authoring shapes; predicate matchers never made it across the port —
 * structured clone rejects functions loudly at send time).
 */
function resolveEngineConfig(wire: AiEngineConfigWire): NonNullable<AIOptions['engine']> {
  if (wire.kind === 'openai') {
    return {
      kind: 'openai',
      baseUrl: wire.baseUrl ?? AI_PROXY_PATH,
      ...(wire.model !== undefined ? { model: wire.model } : {}),
      ...(wire.modelMap !== undefined ? { modelMap: wire.modelMap } : {}),
    };
  }
  const isGeminiWire = wire.kind === 'gemini';
  if (isGeminiWire) {
    const result: Record<string, unknown> = {
      kind: 'gemini',
    };
    const hasBaseUrl = wire.baseUrl !== undefined;
    if (hasBaseUrl) {
      result.baseUrl = wire.baseUrl;
    }
    const hasApiKey = wire.apiKey !== undefined;
    if (hasApiKey) {
      result.apiKey = wire.apiKey;
    }
    return result as unknown as NonNullable<AIOptions['engine']>;
  }
  return {
    kind: 'scripted',
    ...(wire.script !== undefined
      ? { script: wire.script as unknown as Extract<NonNullable<AIOptions['engine']>, { kind: 'scripted' }>['script'] }
      : {}),
  };
}

/**
 * The sandbox's AiBroker, created once per worker lifetime. `getAI` is
 * idempotent per sandbox+backend, so this IS the mirror's broker — a page
 * embedding host and this handler resolve the same instance, and every
 * broker op lands `service: 'ai'` events on the shared sandbox's unified
 * event stream (what Studio consumes).
 *
 * `AiBroker` is not exported from `pyric/ai`'s public surface; the instance
 * is recovered from the branded handle via the exported `TARGET_SYMBOL`
 * (the mirror's own dispatch seam).
 */
export function ensureAiBroker(ctx: HostCtx, opEngine?: AiEngineConfigWire): AiBrokerLike {
  if (ctx.aiBroker) return ctx.aiBroker;
  const wire = ctx.aiEngine ?? opEngine;
  const ai = getAI(ctx.sandbox, wire ? { engine: resolveEngineConfig(wire) } : undefined);
  const target = (ai as unknown as {
    [TARGET_SYMBOL]?: { broker: AiBrokerLike };
  })[TARGET_SYMBOL];
  if (!target?.broker) {
    // Unreachable for a real Sandbox ctx; guards a mis-wired embedding host.
    throw new Error('pyric worker: getAI(sandbox) did not produce a sandbox-target AI handle');
  }
  ctx.aiBroker = target.broker;
  return target.broker;
}

/** Handle the unary AI ops. Requests/replies are plain Gemini-wire JSON. */
export async function handleAiOp(ctx: HostCtx, port: PortLike, msg: OpMessage): Promise<void> {
  const aiMsg = msg as AiOpMessage;
  try {
    const broker = ensureAiBroker(ctx, aiMsg.engine);
    switch (aiMsg.method) {
      case 'ai.generateContent': {
        ok(port, aiMsg.id, await broker.generateContent(aiMsg.request, aiMsg.model));
        break;
      }
      case 'ai.countTokens': {
        ok(port, aiMsg.id, await broker.countTokens(aiMsg.request, aiMsg.model));
        break;
      }
      default: {
        fail(port, msg.id, new Error(`Unknown ai method: ${String((msg as { method: unknown }).method)}`));
      }
    }
  } catch (e) {
    // AiBrokerError envelopes ride the SerializedError whole (aiEnvelope) —
    // serializeError detects them structurally.
    fail(port, aiMsg.id, e);
  }
}

/**
 * Handle an AI stream subscription: pump the broker's chunk stream to the
 * port as `{ chunk }` snaps IN ORDER, then post the terminal `{ done: true }`
 * snap and drop the sub (finite — auto-unsub on done). The pump is detached
 * (sub handling is synchronous, like the other sub handlers); a client
 * `unsub` mid-stream flips the registered cancel and delivery stops.
 *
 * Broker validation runs eagerly inside `streamGenerateContent` (before
 * iteration) — either way a throw lands as the shared `{ __error }` snap
 * convention, terminal for this sub.
 */
export function handleAiSub(ctx: HostCtx, port: PortLike, msg: AiStreamSubMessage): void {
  let portSubs = ctx.subs.get(port);
  if (!portSubs) {
    portSubs = new Map();
    ctx.subs.set(port, portSubs);
  }
  if (portSubs.has(msg.subId)) return; // idempotent

  let cancelled = false;
  const cancel = (): void => {
    cancelled = true;
  };
  portSubs.set(msg.subId, cancel);

  void (async () => {
    try {
      const broker = ensureAiBroker(ctx, msg.engine);
      for await (const chunk of broker.streamGenerateContent(msg.request, msg.model)) {
        if (cancelled) return;
        post(port, { t: 'snap', subId: msg.subId, value: { chunk } });
      }
      if (!cancelled) {
        post(port, { t: 'snap', subId: msg.subId, value: { done: true } });
      }
    } catch (e) {
      if (!cancelled) {
        post(port, { t: 'snap', subId: msg.subId, value: { __error: serializeError(e) } });
      }
    } finally {
      // Auto-unsub: drop OUR registration only (an early client unsub may
      // have already removed it — handleUnsub ran the cancel and deleted it).
      const subs = ctx.subs.get(port);
      if (subs?.get(msg.subId) === cancel) subs.delete(msg.subId);
    }
  })();
}

import { observeAiRequest } from './ai-observation.js';
import { packAiEvidence, setAiEvidence, type AiEvidence } from 'pyric/ai/internal';
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
 *      origin, so the plain path works from inside the SharedWorker. The
 *      gemini engine sends through `/__pyric/ai-proxy/gemini`, where the
 *      server attaches the key, so the key never enters the browser.
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

import { serializeError, type OpMessage, type AiStreamSubMessage, type AiEngineConfigWire, type AiAppCheckWire, type InboundMessage } from './protocol.js';
import { type HostCtx, type PortLike, type AiBrokerLike, post, ok, fail } from './host-context.js';
import { AI_PROXY_PATH, browserGeminiEngine, hasNonBlankApiKey } from './ai-proxy-paths.js';
import { resolveEffectiveAiAppCheck } from './host/app-check.js';
import { callerFor, callerOf } from './host/caller.js';

/** Is this op an AI op (routed here instead of handleOp)? */
export function isAiOp(method: OpMessage['method']): boolean {
  return method.startsWith('ai.');
}

/** The two unary AI op variants, extracted from the OpMessage union. */
type AiOpMessage = Extract<OpMessage, { method: 'ai.generateContent' | 'ai.countTokens' }>;

function proxyFetchWithSessionToken(sessionToken: string | undefined): typeof fetch | undefined {
  if (!sessionToken || typeof fetch !== 'function') return undefined;
  return ((input: RequestInfo | URL, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    if (!headers.has('x-pyric-session-token')) {
      headers.set('x-pyric-session-token', sessionToken);
    }
    return fetch(input, { ...init, headers });
  }) as typeof fetch;
}

function resolveNodeGeminiEngine(
  wire: Extract<AiEngineConfigWire, { kind: 'gemini' }>,
  fromServerConfig: boolean,
): NonNullable<AIOptions['engine']> {
  if (fromServerConfig) {
    const serverConfig: Extract<AiEngineConfigWire, { kind: 'gemini' }> = { kind: 'gemini' };
    if (wire.baseUrl !== undefined) serverConfig.baseUrl = wire.baseUrl;
    if (wire.apiKey !== undefined) serverConfig.apiKey = wire.apiKey;
    return serverConfig;
  }
  // Page-supplied configs on a hosted Node worker must never redirect server
  // GEMINI_API_KEY / GOOGLE_GENAI_API_KEY / ADC credentials to a page-chosen
  // baseUrl (#1599). Allow page baseUrl only when paired with a non-blank
  // page apiKey; otherwise ignore baseUrl and drop blank apiKey.
  if (hasNonBlankApiKey(wire.apiKey)) {
    const pageConfig: Extract<AiEngineConfigWire, { kind: 'gemini' }> = {
      kind: 'gemini',
      apiKey: wire.apiKey.trim(),
    };
    if (wire.baseUrl !== undefined) pageConfig.baseUrl = wire.baseUrl;
    return pageConfig;
  }
  return { kind: 'gemini' };
}

/**
 * Wire config -> the mirror's `EngineConfig`. Browser workers use the proxy;
 * Node resolves that same route to its server-only upstream. Server-configured
 * URLs keep their target; page-supplied Gemini baseUrls on Node are honored
 * only when the page supplies its own non-blank apiKey (#1599). Script entries
 * pass through as-is (they are the broker's own plain authoring shapes;
 * predicate matchers never made it across the port -- structured clone rejects
 * functions loudly at send time).
 */
function resolveEngineConfig(
  wire: AiEngineConfigWire,
  upstream: HostCtx['aiUpstream'],
  runsInBrowser: boolean,
  fromServerConfig: boolean,
  sessionToken?: string,
): NonNullable<AIOptions['engine']> {
  if (wire.kind === 'openai') {
    const configuredUrl = wire.baseUrl ?? AI_PROXY_PATH;
    const usesProxy = configuredUrl.replace(/\/$/, '') === AI_PROXY_PATH;
    const baseUrl = usesProxy ? (upstream?.baseUrl ?? configuredUrl) : configuredUrl;
    const proxyFetch = usesProxy && !upstream?.fetch ? proxyFetchWithSessionToken(sessionToken) : undefined;
    const openAiConfig: Extract<NonNullable<AIOptions['engine']>, { kind: 'openai' }> = {
      kind: 'openai',
      baseUrl,
      fetch: upstream?.fetch ?? proxyFetch,
    };
    if (wire.model !== undefined) openAiConfig.model = wire.model;
    if (wire.modelMap !== undefined) openAiConfig.modelMap = wire.modelMap;
    return openAiConfig;
  }
  const isGeminiWire = wire.kind === 'gemini';
  if (isGeminiWire) {
    if (!runsInBrowser) {
      return resolveNodeGeminiEngine(wire, fromServerConfig);
    }
    const config = browserGeminiEngine(wire);
    const geminiConfig: Extract<NonNullable<AIOptions['engine']>, { kind: 'gemini' }> & {
      serverAttachesAuth?: true;
    } = { kind: 'gemini' };
    if (config.baseUrl !== undefined) geminiConfig.baseUrl = config.baseUrl;
    if (config.apiKey !== undefined) geminiConfig.apiKey = config.apiKey;
    if (config.serverAttachesAuth === true) {
      geminiConfig.serverAttachesAuth = true;
      const proxyFetch = proxyFetchWithSessionToken(sessionToken);
      if (proxyFetch !== undefined) geminiConfig.fetch = proxyFetch;
    }
    return geminiConfig;
  }
  const scriptedConfig: Extract<NonNullable<AIOptions['engine']>, { kind: 'scripted' }> = {
    kind: 'scripted',
  };
  if (wire.script !== undefined) {
    scriptedConfig.script = wire.script as unknown as Extract<
      NonNullable<AIOptions['engine']>,
      { kind: 'scripted' }
    >['script'];
  }
  return scriptedConfig;
}

/**
 * The sandbox's AiBroker, created once per worker lifetime. `getAI` is
 * idempotent per sandbox+backend, so this IS the mirror's broker -- a page
 * embedding host and this handler resolve the same instance, and every
 * broker op lands `service: 'ai'` events on the shared sandbox's unified
 * event stream (what Studio consumes).
 *
 * `AiBroker` is not exported from `pyric/ai`'s public surface; the instance
 * is recovered from the branded handle via the exported `TARGET_SYMBOL`
 * (the mirror's own dispatch seam).
 */
function ensureAiBroker(ctx: HostCtx, opEngine?: AiEngineConfigWire): AiBrokerLike {
  if (ctx.aiBroker) return ctx.aiBroker;
  const fromServerConfig = ctx.aiEngine !== undefined;
  const wire = fromServerConfig ? ctx.aiEngine : opEngine;
  const ai = getAI(
    ctx.sandbox,
    wire
      ? {
          engine: resolveEngineConfig(
            wire,
            ctx.aiUpstream,
            ctx.aiRunsInBrowser === true,
            fromServerConfig,
            ctx.sessionToken,
          ),
        }
      : undefined,
  );
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

/**
 * Fill in `runtime: 'server'` when a frame arrived from a remote Node host
 * connection (`node` / `admin` / `relay`) without specifying a caller runtime,
 * so the dev server terminal shows server App Check guidance rather than the
 * browser `self.` hint (#1736).
 */
function withCallerAppCheckRuntime(
  ctx: HostCtx,
  port: PortLike,
  msg: InboundMessage,
  claim: AiAppCheckWire | undefined,
): AiAppCheckWire | undefined {
  if (claim === undefined) return undefined;
  if (claim.runtime !== undefined) return claim;
  const caller = callerOf(msg) ?? callerFor(ctx, port, msg);
  const connection = ctx.portConnections?.get(port);
  const isServerCaller =
    caller.kind === 'node' ||
    caller.kind === 'admin' ||
    connection === 'node' ||
    connection === 'relay';
  if (!isServerCaller) return claim;
  return { ...claim, runtime: 'server' };
}

/** Handle the unary AI ops. Requests/replies are plain Gemini-wire JSON. */
export async function handleAiOp(ctx: HostCtx, port: PortLike, msg: OpMessage): Promise<void> {
  const aiMsg = msg as AiOpMessage;
  const attachedAppCheck = (msg as { appCheckToken?: string }).appCheckToken;
  const effectiveAppCheck = withCallerAppCheckRuntime(
    ctx,
    port,
    msg,
    resolveEffectiveAiAppCheck(aiMsg.appCheck, attachedAppCheck),
  );
  const observation = observeAiRequest(ctx, port, msg, aiMsg.method.slice(3), aiMsg.model);
  let identity: AiEvidence | undefined;
  try {
    const broker = ensureAiBroker(ctx, aiMsg.engine);
    identity = broker.observationIdentity?.(aiMsg.model);
    observation.identity(identity);
    switch (aiMsg.method) {
      case 'ai.generateContent': {
        const response = await broker.generateContent(aiMsg.request, aiMsg.model, effectiveAppCheck);
        observation.response(response);
        observation.finish('completed');
        ok(port, aiMsg.id, packAiEvidence(response));
        break;
      }
      case 'ai.countTokens': {
        const response = await broker.countTokens(aiMsg.request, aiMsg.model, effectiveAppCheck);
        observation.response(response);
        observation.finish('completed');
        ok(port, aiMsg.id, packAiEvidence(response));
        break;
      }
      default: {
        fail(port, msg.id, new Error(`Unknown ai method: ${String((msg as { method: unknown }).method)}`));
      }
    }
  } catch (e) {
    // AiBrokerError envelopes ride the SerializedError whole (aiEnvelope) —
    // serializeError detects them structurally.
    if (identity && e && typeof e === 'object') setAiEvidence(e, identity);
    observation.finish('failed', e);
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
 * The App Check gate runs first, then broker validation runs eagerly inside
 * `streamGenerateContent` (before iteration) — either way a throw lands as
 * the shared `{ __error }` snap convention, terminal for this sub.
 */
export function handleAiSub(ctx: HostCtx, port: PortLike, msg: AiStreamSubMessage): void {
  let portSubs = ctx.subs.get(port);
  if (!portSubs) {
    portSubs = new Map();
    ctx.subs.set(port, portSubs);
  }
  if (portSubs.has(msg.subId)) return; // idempotent

  const observation = observeAiRequest(ctx, port, msg, 'generateContentStream', msg.model);
  let cancelled = false;
  const cancel = (): void => {
    cancelled = true;
    observation.finish('cancelled');
  };
  portSubs.set(msg.subId, cancel);

  void (async () => {
    let identity: AiEvidence | undefined;
    try {
      const broker = ensureAiBroker(ctx, msg.engine);
      identity = broker.observationIdentity?.(msg.model);
      observation.identity(identity);
      const attachedAppCheck = (msg as { appCheckToken?: string }).appCheckToken;
      const effectiveAppCheck = withCallerAppCheckRuntime(
        ctx,
        port,
        msg,
        resolveEffectiveAiAppCheck(msg.appCheck, attachedAppCheck),
      );
      // The App Check gate answers before any chunk, as AI Logic answers 403 before a stream.
      await broker.admitAppCheck(msg.model, effectiveAppCheck);
      for await (const chunk of broker.streamGenerateContent(msg.request, msg.model, effectiveAppCheck)) {
        if (cancelled) return;
        observation.response(chunk, true);
        post(port, { t: 'snap', subId: msg.subId, value: { chunk: packAiEvidence(chunk) } });
      }
      if (!cancelled) {
        observation.finish('completed');
        post(port, { t: 'snap', subId: msg.subId, value: { done: true } });
      }
    } catch (e) {
      if (!cancelled) {
        observation.finish('failed', e);
        if (identity && e && typeof e === 'object') setAiEvidence(e, identity);
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

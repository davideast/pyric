/**
 * The bundle the import map serves for `firebase/ai`.
 *
 * DUAL-PATH (cdd-deltas #98): the FULL `pyric/ai` mirror surface
 * (GenerativeModel / ChatSession / Schema / enums) always runs in-page —
 * but ANSWERING follows the sandbox. When a SharedWorker is available, the
 * broker + engines live in the WORKER HOST, in-process with the ONE shared
 * sandbox (#98.1): `getAI` plugs a port-forwarding AnswerEngine into the
 * in-page mirror, so every `generateContent` / `streamGenerateContent` /
 * `countTokens` rides the worker protocol's `ai.*` ops (#98.3) and the
 * worker broker's `service: 'ai'` events land on the shared event stream
 * Studio consumes. Otherwise the mirror runs whole against the in-page
 * sandbox — the unchanged fallback. Branch picked ONCE at load (`useWorker`).
 *
 * OPENAI ENGINE IN THE BROWSER (#98.2): an `engine: { kind: 'openai' }`
 * config with no `baseUrl` targets serve's same-origin `/__pyric/ai-proxy`
 * route (which forwards to the configured upstream, default
 * `http://localhost:11434/v1`) — so a localhost Ollama needs no CORS setup
 * on EITHER path. A custom AnswerEngine OBJECT can't cross the port; it
 * stays in-page (answers against the page context) on both paths.
 *
 * Engine config is per-sandbox (#98.4) and first-call-wins, mirroring
 * `getAI`'s idempotence — on the worker path the FIRST ai op's config
 * creates the worker broker; later configs are ignored.
 * Browser-bundled by `../bundler.ts`; never imported by node-side.
 */
import * as ipAi from 'pyric/ai';
import { getAI as pyricGetAI } from 'pyric/ai';
import type { PyricApp } from 'pyric/app';
import type { AiEngineConfigWire } from '../worker/protocol.js';
import { aiGenerateContent, aiCountTokens, aiStreamGenerateContent } from '../worker/client.js';
import { sandbox, workerDb, useWorker } from './runtime.js';

// ── Mirror surface — path-independent (the mirror always runs in-page) ────
export {
  AIError,
  AIErrorCode,
  Backend,
  BackendType,
  GoogleAIBackend,
  VertexAIBackend,
  AIModel,
  ChatSession,
  ChatSessionBase,
  GenerativeModel,
  AnyOfSchema,
  ArraySchema,
  BooleanSchema,
  IntegerSchema,
  NumberSchema,
  ObjectSchema,
  Schema,
  StringSchema,
  BlockReason,
  FinishReason,
  FunctionCallingMode,
  HarmBlockMethod,
  HarmBlockThreshold,
  HarmCategory,
  HarmProbability,
  HarmSeverity,
  ImageConfigAspectRatio,
  ImageConfigImageSize,
  Language,
  Modality,
  Outcome,
  POSSIBLE_ROLES,
  ResponseModality,
  SchemaType,
  ThinkingLevel,
  URLRetrievalStatus,
  getGenerativeModel,
} from 'pyric/ai';

type EngineOption = NonNullable<ipAi.AIOptions['engine']>;

/** The serve proxy route the browser openai engine defaults to (#98.2). */
const AI_PROXY_PATH = '/__pyric/ai-proxy';

/** A custom AnswerEngine object (vs a plain EngineConfig). Runs in-page. */
function isAnswerEngine(engine: EngineOption): boolean {
  return typeof (engine as { generateContent?: unknown }).generateContent === 'function';
}

/**
 * Derive the JSON-safe wire config that crosses the port from the app's
 * `AIOptions.engine`. Predicate script matchers are functions — structured
 * clone rejects them LOUDLY at send time (never silently dropped).
 */
function toEngineWire(engine: EngineOption | undefined): AiEngineConfigWire | undefined {
  if (!engine || isAnswerEngine(engine)) return undefined;
  const config = engine as Exclude<EngineOption, { generateContent: unknown }> & { kind: string };
  if (config.kind === 'openai') {
    const openai = config as Extract<EngineOption, { kind: 'openai' }>;
    return {
      kind: 'openai',
      baseUrl: openai.baseUrl ?? AI_PROXY_PATH,
      ...(openai.model !== undefined ? { model: openai.model } : {}),
      ...(openai.modelMap !== undefined ? { modelMap: openai.modelMap } : {}),
    };
  }
  const scripted = config as Extract<EngineOption, { kind: 'scripted' }>;
  return {
    kind: 'scripted',
    ...(scripted.script !== undefined
      ? { script: scripted.script as unknown as Array<Record<string, unknown>> }
      : {}),
  };
}

/** In-page path: default an openai config's absent baseUrl to the proxy. */
function withProxyDefault(options?: ipAi.AIOptions): ipAi.AIOptions | undefined {
  const engine = options?.engine;
  if (!engine || isAnswerEngine(engine)) return options;
  const config = engine as { kind?: string; baseUrl?: string };
  if (config.kind === 'openai' && config.baseUrl === undefined) {
    return { ...options, engine: { ...config, baseUrl: AI_PROXY_PATH } as EngineOption };
  }
  return options;
}

// ── Worker-side error fidelity ─────────────────────────────────────────────
// A worker broker error crosses the port as `{ code: 'ai/<STATUS>',
// message, aiEnvelope }` (protocol.ts). Re-mint the SAME
// `AIError('fetch-error', …)` decoration the in-process plane applies
// (pyric/ai's aiErrorFromEnvelope — replicated here because the plane's
// translation seam only recognizes its own in-process AiBrokerError class).

function statusTextOf(status: number): string {
  switch (status) {
    case 400: return 'Bad Request';
    case 401: return 'Unauthorized';
    case 403: return 'Forbidden';
    case 404: return 'Not Found';
    case 429: return 'Too Many Requests';
    case 500: return 'Internal Server Error';
    case 502: return 'Bad Gateway';
    case 503: return 'Service Unavailable';
    default: return '';
  }
}

function aiErrorFromWire(err: unknown, modelResource: string, op: string): unknown {
  const envelope = (err as { aiEnvelope?: { error?: { code: number; message: string; status: string; details?: Array<Record<string, unknown>> } } } | null)?.aiEnvelope;
  const wire = envelope?.error;
  if (!wire) return err;
  let message = wire.message;
  let errorDetails: Array<Record<string, unknown>> | undefined;
  if (wire.details) {
    message += ` ${JSON.stringify(wire.details)}`;
    errorDetails = wire.details;
  }
  const statusText = statusTextOf(wire.code);
  const url = `https://firebasevertexai.googleapis.com/v1beta/projects/sandbox/${modelResource}:${op}`;
  return new ipAi.AIError(
    ipAi.AIErrorCode.FETCH_ERROR,
    `Error fetching from ${url}: [${wire.code} ${statusText}] ${message}`,
    { status: wire.code, statusText, errorDetails },
  );
}

// ── The port-forwarding AnswerEngine (worker path) ─────────────────────────

function portEngine(engineWire: AiEngineConfigWire | undefined): EngineOption {
  const db = workerDb!;
  const params = (model: string, request: Record<string, unknown>) => ({
    model,
    request,
    ...(engineWire !== undefined ? { engine: engineWire } : {}),
  });
  const engine = {
    async generateContent(req: Record<string, unknown>, model: string): Promise<Record<string, unknown>> {
      try {
        return await aiGenerateContent(db, params(model, req));
      } catch (err) {
        throw aiErrorFromWire(err, model, 'generateContent');
      }
    },
    streamGenerateContent(req: Record<string, unknown>, model: string): AsyncIterable<Record<string, unknown>> {
      const inner = aiStreamGenerateContent(db, params(model, req));
      return (async function* mapped(): AsyncGenerator<Record<string, unknown>> {
        try {
          for await (const chunk of inner) yield chunk;
        } catch (err) {
          throw aiErrorFromWire(err, model, 'streamGenerateContent');
        }
      })();
    },
    async countTokens(req: Record<string, unknown>, model: string): Promise<Record<string, unknown>> {
      try {
        return await aiCountTokens(db, params(model, req));
      } catch (err) {
        throw aiErrorFromWire(err, model, 'countTokens');
      }
    },
  };
  return engine as unknown as EngineOption;
}

// ── getAI — worker-forwarded answering or whole-mirror in-page ─────────────
function mirrorGetAI(app: unknown, options?: ipAi.AIOptions): ipAi.AI {
  return app === undefined
    ? pyricGetAI(sandbox, options)
    : pyricGetAI(app as PyricApp, options);
}

export const getAI = (
  useWorker
    ? (app?: unknown, options?: ipAi.AIOptions) => {
        const engine = options?.engine;
        if (engine && isAnswerEngine(engine)) {
          // A custom AnswerEngine is page code — it can't cross the port, so
          // the whole mirror (broker included) runs in-page against it.
          return mirrorGetAI(app, options);
        }
        return mirrorGetAI(app, { ...(options ?? {}), engine: portEngine(toEngineWire(engine)) });
      }
    : (app?: unknown, options?: ipAi.AIOptions) => mirrorGetAI(app, withProxyDefault(options))
) as typeof pyricGetAI;

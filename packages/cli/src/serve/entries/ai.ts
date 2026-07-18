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
 * on EITHER path. A custom AnswerEngine OBJECT can't cross the port and is
 * rejected in worker mode rather than creating a second page-local backend.
 * Direct/in-process `pyric/ai` sandboxes still accept custom engines.
 *
 * Engine config is per-sandbox (#98.4) and first-call-wins at the worker
 * host. Each app has its own in-page port wrapper so deleting one app cannot
 * disconnect a sibling; all wrappers still forward to that one worker broker.
 * Browser-bundled by `../bundler.ts`; never imported by node-side.
 */
import * as ipAi from 'pyric/ai';
import { aiErrorFromEnvelope } from 'pyric/ai/internal';
import { getAI as pyricGetAI } from 'pyric/ai';
import { createTransportAI } from 'pyric/ai/internal';
import { FirebaseError, getApp, type FirebaseApp } from 'pyric/app';
import { isSandboxAppDeleted } from 'pyric/app/internal';
import type { AiEngineConfigWire } from '../worker/protocol.js';
import { aiGenerateContent, aiCountTokens, aiStreamGenerateContent } from '../worker/client.js';
import { useWorker } from './worker-runtime.js';
import { workerClientForApp } from './app-client.js';

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
type AnswerTransport = Parameters<typeof createTransportAI>[2];

/** The serve proxy route the browser openai engine defaults to (#98.2). */
const AI_PROXY_PATH = '/__pyric/ai-proxy';

/** A custom AnswerEngine object (vs a plain, worker-cloneable EngineConfig). */
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

/**
 * The plugin-level engine (`@pyric/cli/vite`'s `ai.engine`) for the IN-PAGE
 * path, injected as a synchronous global BEFORE any app code runs (the plugin's
 * transformIndexHtml — a classic inline script). The served `getAI` is
 * synchronous and can't await init.json, so the worker path's init.json channel
 * (→ ctx.aiEngine) has this page-side twin. Undefined outside the plugin.
 */
function pluginEngineWire(): AiEngineConfigWire | undefined {
  return (globalThis as { __PYRIC_AI_ENGINE__?: AiEngineConfigWire }).__PYRIC_AI_ENGINE__;
}

/**
 * Resolve a plugin wire engine to the mirror's `EngineOption` — an openai
 * config with no `baseUrl` targets the serve proxy (mirrors resolveEngineConfig
 * host-side and toEngineWire's inverse).
 */
function wireToEngineOption(wire: AiEngineConfigWire): EngineOption {
  if (wire.kind === 'openai') {
    return {
      kind: 'openai',
      baseUrl: wire.baseUrl ?? AI_PROXY_PATH,
      ...(wire.model !== undefined ? { model: wire.model } : {}),
      ...(wire.modelMap !== undefined ? { modelMap: wire.modelMap } : {}),
    } as EngineOption;
  }
  return {
    kind: 'scripted',
    ...(wire.script !== undefined
      ? { script: wire.script as unknown as Extract<EngineOption, { kind: 'scripted' }>['script'] }
      : {}),
  } as EngineOption;
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

function aiErrorFromWire(err: unknown, modelResource: string, op: string): unknown {
  const envelope = (err as { aiEnvelope?: Parameters<typeof aiErrorFromEnvelope>[0] } | null)
    ?.aiEnvelope;
  return envelope ? aiErrorFromEnvelope(envelope, modelResource, op) : err;
}

// ── The port-forwarding AnswerEngine (worker path) ─────────────────────────

function portEngine(db: ReturnType<typeof workerClientForApp>, engineWire: AiEngineConfigWire | undefined): AnswerTransport {
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
  return engine as unknown as AnswerTransport;
}

/**
 * Firebase constructs an AI handle for a deleted app, but that observation
 * does not authorize resurrecting the app against an in-page sandbox. Keep
 * the handle constructible while every model operation stays tombstoned.
 */
function deletedAppEngine(): AnswerTransport {
  return {
    async generateContent(): Promise<never> {
      throw deletedAppError();
    },
    streamGenerateContent(): AsyncIterable<never> {
      return (async function* tombstoned(): AsyncGenerator<never> {
        throw deletedAppError();
      })();
    },
    async countTokens(): Promise<never> {
      throw deletedAppError();
    },
  } as AnswerTransport;
}

function deletedAppError(): FirebaseError {
  return new FirebaseError(
    'app/app-deleted',
    'Firebase App has already been deleted.',
  );
}

// ── getAI — worker-forwarded answering or whole-mirror in-page ─────────────
function mirrorGetAI(
  app: unknown,
  options?: ipAi.AIOptions,
): ipAi.AI {
  const resolved = (app ?? getApp()) as FirebaseApp;
  const ai = pyricGetAI(resolved, options);
  const target = (ai as unknown as {
    [ipAi.TARGET_SYMBOL]?: { assertAlive?: () => void };
  })[ipAi.TARGET_SYMBOL];
  if (target) {
    // Served entries are separately bundled, so the in-page AI mirror cannot
    // rely on sharing pyric/app's private adapter singleton. Stamp the target
    // with the served registry's per-app deletion guard instead. The target is
    // per app handle even though its broker is shared by the sandbox.
    target.assertAlive = () => {
      if (isSandboxAppDeleted(resolved)) throw deletedAppError();
    };
  }
  return ai;
}

export const getAI = (
  useWorker
    ? (app?: unknown, options?: ipAi.AIOptions) => {
        const resolved = (app ?? getApp()) as FirebaseApp;
        const engine = options?.engine;
        const assertAlive = () => {
          if (isSandboxAppDeleted(resolved)) throw deletedAppError();
        };
        if (isSandboxAppDeleted(resolved)) {
          return createTransportAI(
            resolved,
            options,
            deletedAppEngine(),
            assertAlive,
          );
        }
        if (engine && isAnswerEngine(engine)) {
          throw new ipAi.AIError(
            ipAi.AIErrorCode.UNSUPPORTED,
            'Custom AnswerEngine objects cannot run in SharedWorker mode. ' +
              "Use a structured { kind: 'scripted' } or { kind: 'openai' } engine config.",
          );
        }
        return createTransportAI(
          resolved,
          options,
          portEngine(workerClientForApp(resolved), toEngineWire(engine)),
          assertAlive,
        );
      }
    : (app?: unknown, options?: ipAi.AIOptions) => {
        // Plugin-level engine wins over an app-code `getAI` engine (mirrors the
        // worker host's ctx.aiEngine precedence). Absent ⇒ app options as-is.
        const pluginWire = pluginEngineWire();
        return pluginWire
          ? mirrorGetAI(app, { ...options, engine: wireToEngineOption(pluginWire) })
          : mirrorGetAI(app, withProxyDefault(options));
      }
) as typeof pyricGetAI;

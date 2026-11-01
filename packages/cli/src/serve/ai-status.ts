/**
 * The AI line in the dev server's startup banner.
 *
 * AI is the only live service that used to boot silently: hosting, sandbox
 * bundles, rules, Studio, the bridge and persistence all announce themselves,
 * so "nothing about AI" read as "AI isn't part of this server" rather than
 * "AI is here, unconfigured". One description ({@link describeAiStatus}),
 * rendered in the two dev-server flavors, so the `pyric dev` banner and the
 * Vite plugin can never disagree about what AI resolved to.
 */
import type { AiEngineConfigWire } from './worker/protocol.js';
import { GEMINI_DEFAULT_BASE_URL, hasGeminiStaticKey, redactUrl } from 'pyric/ai/internal';
import { AI_PROXY_ROUTE, resolveAiProxyUpstream } from './ai-proxy.js';
import { sanitizeForTerminal } from './ai-terminal-text.js';

/**
 * What the dev server itself knows about AI by the time it finishes booting.
 *
 * Everything here is resolved SYNCHRONOUSLY at bootstrap: the plugin's
 * `ai.engine`/`ai.model` (already reduced to the worker wire shape) and the
 * proxy upstream. Nothing in this shape forces a broker, a page, or an
 * upstream connection into existence just to be reported. The engine is
 * instantiated lazily, on the first `ai.*` op, in the page or the worker.
 */
export interface AiStartupStatus {
  /** The AI broker runs in the server and reaches its upstream directly. */
  hosted?: boolean;
  /** Engine resolved by the dev server (the Vite plugin's `ai.engine` /
   *  `ai.model`). Absent means nothing server-side: the served page's own
   *  `getAI(...)` chooses the engine at runtime, and the server cannot know
   *  which (there is no CLI surface for it under `pyric dev`). */
  engine?: AiEngineConfigWire;
  /** `ai.mode` or `PYRIC_AI_MODE`: `production` leaves `firebase/ai` to the
   *  Firebase SDK, so no engine runs on this server. */
  mode?: 'sandbox' | 'production';
  /** Configured OpenAI-compatible upstream (`ai.proxyUpstream`). Absent falls
   *  back to `PYRIC_AI_PROXY_UPSTREAM`, then the local-Ollama default. */
  proxyUpstream?: string;
}

/** Where the resolved proxy upstream came from, in the terminal's words. The
 *  provenance is the point of the line: a developer has to be able to tell a
 *  deliberate upstream from the Ollama default nobody chose, so every source
 *  names the knob that set it. */
function describeUpstreamProvenance(source: 'option' | 'env' | 'default'): string {
  if (source === 'option') return ' (ai.proxyUpstream)';
  if (source === 'env') return ' (PYRIC_AI_PROXY_UPSTREAM)';
  return ' (default)';
}

/** The openai engine's model binding, which may not be pinned at all. */
function describeOpenAiModel(model: string | undefined): string {
  if (model === undefined) return 'no model pinned';
  return `model ${sanitizeForTerminal(model)}`;
}

/**
 * The Gemini key name Pyric does not read: Vite serves every `VITE_` variable
 * to the browser, so a key there would reach the page (#1632).
 */
const IGNORED_GEMINI_KEY = 'VITE_GEMINI_API_KEY';

/**
 * Why there is no key, when the only Gemini key in the environment is one
 * Pyric ignores, or `null`. People moving a key out of `VITE_GEMINI_API_KEY`
 * see from the banner why it no longer counts (#1659). Never the value.
 */
function ignoredGeminiKeyNote(): string | null {
  if (hasGeminiStaticKey(undefined)) return null;
  const value = process.env[IGNORED_GEMINI_KEY];
  const holdsKey = value !== undefined && value.trim() !== '';
  if (!holdsKey) return null;
  return `${IGNORED_GEMINI_KEY} is set and ignored, because Vite serves every VITE_ variable to the browser; rename it to GEMINI_API_KEY`;
}

/** Mark + body for one AI status line, in both terminal flavors. */
function describeAiStatus(status: AiStartupStatus): { mark: string; body: string } {
  const upstream = resolveAiProxyUpstream(status.proxyUpstream);
  const provenance = describeUpstreamProvenance(upstream.source);
  const upstreamTarget = `${redactUrl(upstream.target)}${provenance}`;
  const proxyChain = status.hosted
    ? `${upstreamTarget} (direct from Node)`
    : `${AI_PROXY_ROUTE} → ${upstreamTarget}`;

  if (status.mode === 'production') {
    // No broker, no key on this server: the page's `firebase/ai` is the
    // Firebase SDK and authenticates with the app's own config.
    return {
      mark: '✔',
      body: "production passthrough; firebase/ai is the Firebase SDK, calling Google AI or Vertex AI with the app's initializeApp config",
    };
  }
  const engine = status.engine;
  const ignoredKeyNote = ignoredGeminiKeyNote();
  if (engine === undefined) {
    // Visible absence, the `• rules    no firestore.rules ...` idiom: AI
    // silence used to be indistinguishable from AI-not-wired-up. The page
    // can still pick gemini, whose key this server attaches, so an ignored
    // key is named here too.
    let body = `no engine configured; the served page's getAI() picks one; ${proxyChain}`;
    if (ignoredKeyNote !== null) body = `${body}; ${ignoredKeyNote}`;
    return { mark: '•', body };
  }
  if (engine.kind === 'openai') {
    const model = describeOpenAiModel(engine.model);
    const baseUrl = engine.baseUrl ?? AI_PROXY_ROUTE;
    let endpoint = proxyChain;
    if (baseUrl !== AI_PROXY_ROUTE) {
      endpoint = `${redactUrl(baseUrl)} (direct, bypasses ${AI_PROXY_ROUTE})`;
    }
    return { mark: '✔', body: `openai (${model}) → ${endpoint}` };
  }
  if (engine.kind === 'gemini') {
    // The engine's own check, so the banner and the engine cannot disagree.
    // It reads `process.env`, which the Vite plugin has already filled from
    // `.env` (`loadViteAiEnv`) before this prints.
    const hasKey = hasGeminiStaticKey(engine.apiKey);
    let key = 'no API key; set GEMINI_API_KEY';
    if (ignoredKeyNote !== null) key = `no API key; ${ignoredKeyNote}`;
    if (hasKey) key = 'API key set';
    let endpoint = GEMINI_DEFAULT_BASE_URL;
    if (engine.baseUrl !== undefined) endpoint = redactUrl(engine.baseUrl);
    return { mark: '✔', body: `gemini (${key}) → ${endpoint}` };
  }
  const responses = engine.script?.length ?? 0;
  return { mark: '✔', body: `scripted (${responses} canned response(s), no network)` };
}

/**
 * The banner line for `pyric dev`'s aligned status column (`✔ hosting  ...`).
 * Exported for unit tests.
 */
export function formatAiStatusLine(status: AiStartupStatus): string {
  const { mark, body } = describeAiStatus(status);
  return `${mark} ai       ${body}`;
}

/**
 * The same report in the Vite dev server's flavor (`  ✔ [pyric] ...`, the
 * idiom `vite-functions-development.ts` prints). Same content, so the two
 * dev-server front doors never disagree about what AI resolved to.
 */
export function formatAiStatusNote(status: AiStartupStatus): string {
  const { mark, body } = describeAiStatus(status);
  return `  ${mark} [pyric] ai: ${body}`;
}

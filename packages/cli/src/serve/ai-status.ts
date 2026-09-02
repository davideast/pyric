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
import { GEMINI_DEFAULT_BASE_URL, redactUrl } from 'pyric/ai/internal';
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
  /** Engine resolved by the dev server (the Vite plugin's `ai.engine` /
   *  `ai.model`). Absent means nothing server-side: the served page's own
   *  `getAI(...)` chooses the engine at runtime, and the server cannot know
   *  which (there is no CLI surface for it under `pyric dev`). */
  engine?: AiEngineConfigWire;
  /** `ai.mode`: `production` passes through to Google AI instead of mirroring. */
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

/** Mark + body for one AI status line, in both terminal flavors. */
function describeAiStatus(status: AiStartupStatus): { mark: string; body: string } {
  const upstream = resolveAiProxyUpstream(status.proxyUpstream);
  const provenance = describeUpstreamProvenance(upstream.source);
  const proxyChain = `${AI_PROXY_ROUTE} → ${redactUrl(upstream.target)}${provenance}`;

  const engine = status.engine;
  if (engine === undefined) {
    // Visible absence, the `• rules    no firestore.rules ...` idiom: AI
    // silence used to be indistinguishable from AI-not-wired-up.
    return {
      mark: '•',
      body: `no engine configured; the served page's getAI() picks one; ${proxyChain}`,
    };
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
    let passthrough = '';
    if (status.mode === 'production') passthrough = 'production passthrough, ';
    const hasKey = engine.apiKey !== undefined && engine.apiKey !== '';
    let key = 'no API key; set GEMINI_API_KEY';
    if (hasKey) key = 'API key set';
    let endpoint = GEMINI_DEFAULT_BASE_URL;
    if (engine.baseUrl !== undefined) endpoint = redactUrl(engine.baseUrl);
    return { mark: '✔', body: `gemini (${passthrough}${key}) → ${endpoint}` };
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

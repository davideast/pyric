/**
 * The dev server's AI proxy routes, as the browser engines name them, and
 * the gemini engine a browser page or SharedWorker runs.
 *
 * Browser-safe: the worker host and the served `firebase/ai` entry import
 * this, so it imports nothing from node.
 */
import type { AiEngineConfigWire } from './protocol.js';

/** The serve proxy route the browser openai engine defaults to (#98.2). */
export const AI_PROXY_PATH = '/__pyric/ai-proxy';

/** The serve route a browser gemini engine sends through. The server sends
 *  each request on to Gemini with the key from its own environment (#1584). */
export const GEMINI_PROXY_PATH = `${AI_PROXY_PATH}/gemini`;

type GeminiWire = Extract<AiEngineConfigWire, { kind: 'gemini' }>;

/** A browser gemini engine config: the wire shape, plus the flag that tells
 *  the engine the dev server attaches the credentials. */
export type BrowserGeminiEngine = GeminiWire & { serverAttachesAuth?: true };

/** True when a wire or engine config provides a non-empty static API key. */
export function hasNonBlankApiKey(apiKey: string | undefined): apiKey is string {
  return typeof apiKey === 'string' && apiKey.trim().length > 0;
}

/**
 * The gemini engine config for a browser. The browser has no server
 * environment, so a config without a non-blank `apiKey` sends through the dev
 * server's {@link GEMINI_PROXY_PATH}, which attaches the key and sends to
 * the server's configured base URL: the key never reaches the browser. A
 * config with a non-blank `apiKey` already holds its key in the browser, so
 * it keeps its own target.
 */
export function browserGeminiEngine(wire: GeminiWire): BrowserGeminiEngine {
  if (hasNonBlankApiKey(wire.apiKey)) {
    const result: BrowserGeminiEngine = { kind: 'gemini', apiKey: wire.apiKey.trim() };
    if (wire.baseUrl !== undefined) {
      result.baseUrl = wire.baseUrl;
    }
    return result;
  }
  return { kind: 'gemini', baseUrl: GEMINI_PROXY_PATH, serverAttachesAuth: true };
}

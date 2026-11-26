import { redactUpstreamUrl } from 'pyric/ai/internal';
import { SANDBOX_BUILD_MARKER } from './sandbox-marker.js';
import type { AiEngineConfigWire } from './worker/protocol.js';

/**
 * The engine wire shape served to the browser (`globalThis.__PYRIC_AI_ENGINE__`
 * and `/__pyric/init.json`): never carries a configured Gemini `apiKey` (#1591)
 * or upstream URL userinfo (#1766). Every Gemini engine collapses to
 * `{ kind: 'gemini' }`, because browser execution routes through
 * `/__pyric/ai-proxy/gemini` (which keeps the full server config) and
 * `hosted: true` receives the full config directly on the Node host.
 */
export function browserAiEngineWire(
  wire: AiEngineConfigWire | undefined,
): AiEngineConfigWire | undefined {
  if (wire === undefined || wire.kind === 'scripted') return wire;
  if (wire.kind === 'gemini') {
    return { kind: 'gemini' };
  }
  const sanitized: Extract<AiEngineConfigWire, { kind: 'openai' }> = {
    kind: 'openai',
  };
  if (wire.baseUrl !== undefined) {
    sanitized.baseUrl = redactUpstreamUrl(wire.baseUrl);
  }
  if (wire.model !== undefined) {
    sanitized.model = wire.model;
  }
  if (wire.modelMap !== undefined) {
    sanitized.modelMap = wire.modelMap;
  }
  return sanitized;
}

const SERVE_AI_ENGINE_MARKER = 'data-pyric-ai-engine';

/**
 * Stamp `globalThis.__PYRIC_AI_ENGINE__` into HTML served by `pyric sandbox`
 * ahead of the import map and `/__pyric/sdk/init.js` so the synchronous
 * in-page fallback and runtime chip see the same sanitized engine wire shape
 * as Vite's `transformIndexHtml`.
 */
export function injectServeAiEngineTag(
  html: string,
  browserEngine: AiEngineConfigWire | undefined,
): string {
  if (browserEngine === undefined) return html;
  if (html.includes(SERVE_AI_ENGINE_MARKER) || html.includes(SANDBOX_BUILD_MARKER)) {
    return html;
  }
  const serialized = JSON.stringify(browserEngine).replace(/</g, '\\u003c');
  const tag = `<script ${SERVE_AI_ENGINE_MARKER}>globalThis.__PYRIC_AI_ENGINE__=${serialized};</script>`;
  const importMapIndex = html.indexOf('<script type="importmap"');
  if (importMapIndex >= 0) {
    return html.slice(0, importMapIndex) + tag + html.slice(importMapIndex);
  }
  const headMatch = /<head[^>]*>/i.exec(html);
  if (headMatch !== null) {
    const at = headMatch.index + headMatch[0].length;
    return html.slice(0, at) + tag + html.slice(at);
  }
  return tag + html;
}

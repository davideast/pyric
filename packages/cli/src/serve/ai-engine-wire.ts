import { redactUpstreamUrl } from 'pyric/ai/internal';
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

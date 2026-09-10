/**
 * The resolved AI Logic engine's mode, model, upstream, and whether a key is
 * configured. Never a key value, a key prefix, or a key length: `keyPresent`
 * is the only signal a caller gets.
 *
 * `engine` names what's actually running: `scripted` is the local mirror
 * `script` and friends control; `openai` is a local loopback upstream
 * (Ollama, llama.cpp, or another OpenAI-compatible server); `gemini` is
 * production pass-through to Google AI or Vertex AI, where `script`,
 * `clearScripts`, and `scripts` are refused because there is no local queue
 * to affect.
 */
import { z } from 'zod';
import { aiStatus } from 'pyric/ai/scripting';
import { aiFor } from '../../service-handles.js';
import type { MethodRecord } from '../../method-types.js';

export default {
  tool: 'ai_logic',
  method: 'status',
  sdkOrigin: 'pyric',
  effect: 'read',
  signature: 'status()',
  description:
    "The resolved AI Logic engine (scripted, openai loopback, or gemini production pass-through), its model and upstream when it has one, and whether a key is configured. Never the key itself.",
  args: z.object({}),
  operation: 'get_ai_logic_status',
  example: {},
  async handler(_args, ctx) {
    const status = aiStatus(aiFor(ctx));
    const pass = status.engine === 'gemini' ? ' Production pass-through: script only affects the local scripted engine.' : '';
    return {
      ok: true,
      summary: `engine=${status.engine}${pass}`,
      data: { ...status },
    };
  },
} satisfies MethodRecord;

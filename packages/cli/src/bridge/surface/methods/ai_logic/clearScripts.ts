/**
 * Empty the local scripted answer engine's entry queue. A later call the
 * queue used to match now falls through to the engine's own default, until
 * `script` queues entries again.
 *
 * Reaches only the scripted engine, refused the way `script` is when a
 * different engine is configured.
 */
import { z } from 'zod';
import { AIError, AIErrorCode } from 'pyric/ai';
import { clearScripts as clearScriptsEngine } from 'pyric/ai/scripting';
import { operationFailure } from '../../context.js';
import { aiFor } from '../../service-handles.js';
import type { MethodRecord } from '../../method-types.js';

export default {
  tool: 'ai_logic',
  method: 'clearScripts',
  sdkOrigin: 'pyric',
  effect: 'write',
  signature: 'clearScripts()',
  description:
    "Empty the local scripted answer engine's queue. Never sends a prompt anywhere, and refused when a different engine is configured.",
  args: z.object({}),
  operation: 'clear_ai_logic_scripts',
  example: {},
  async handler(_args, ctx) {
    try {
      clearScriptsEngine(aiFor(ctx));
    } catch (error) {
      if (!(error instanceof AIError) || error.code !== AIErrorCode.UNSUPPORTED) throw error;
      return operationFailure(error.message);
    }
    return { ok: true, summary: 'Cleared the scripted response queue.', data: {} };
  },
} satisfies MethodRecord;

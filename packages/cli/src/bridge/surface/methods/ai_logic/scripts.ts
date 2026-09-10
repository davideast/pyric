/**
 * The scripted answer engine's queued entries, each beside whether it has
 * already answered a call. A model-only or combined matcher reports the
 * `{substring?, model?}` it was registered with; `script` is the only way
 * an entry with a model matcher gets onto this queue, so the descriptor
 * `scripts` reads back is always one this tool itself wrote.
 */
import { z } from 'zod';
import { AIError, AIErrorCode } from 'pyric/ai';
import { scripts as scriptsEngine } from 'pyric/ai/scripting';
import { operationFailure } from '../../context.js';
import { aiFor } from '../../service-handles.js';
import { describeMatch, describeRespond } from '../../ai-logic-matchers.js';
import type { MethodRecord } from '../../method-types.js';

export default {
  tool: 'ai_logic',
  method: 'scripts',
  sdkOrigin: 'pyric',
  effect: 'read',
  signature: 'scripts()',
  description:
    "The local scripted answer engine's queued entries, each beside its match and whether it has already answered a call.",
  args: z.object({}),
  operation: 'list_ai_logic_scripts',
  example: {},
  async handler(_args, ctx) {
    let entries;
    try {
      entries = scriptsEngine(aiFor(ctx));
    } catch (error) {
      if (!(error instanceof AIError) || error.code !== AIErrorCode.UNSUPPORTED) throw error;
      return operationFailure(error.message);
    }
    const scripts = entries.map((slot) => ({
      match: describeMatch(slot.entry.match),
      response: describeRespond(slot.entry.respond),
      consumed: slot.consumed,
    }));
    return {
      ok: true,
      summary: `${scripts.length} scripted response(s)`,
      data: { scripts },
    };
  },
} satisfies MethodRecord;

/**
 * Discover the RTDB triggers a project's Functions source defines: the
 * handlers the runtime can fire, their reference patterns, and any exports
 * that name an event type the runtime does not support yet, with the reason
 * each one was turned away.
 */
import { z } from 'zod';
import { discoverFunctionsTriggers } from '../../functions-runtime.js';
import type { MethodRecord } from '../../method-types.js';

/** The discovered trigger, without the live callable a JSON result cannot carry. */
function describeTrigger(trigger: {
  exportName: string;
  reference: string;
  instance: string;
  location?: string;
}): Record<string, unknown> {
  const described: Record<string, unknown> = {
    exportName: trigger.exportName,
    reference: trigger.reference,
    instance: trigger.instance,
  };
  if (trigger.location !== undefined) described.location = trigger.location;
  return described;
}

export default {
  tool: 'functions',
  method: 'listTriggers',
  sdkOrigin: 'pyric',
  effect: 'read',
  signature: 'listTriggers()',
  description:
    "Discovered RTDB trigger handlers, their reference patterns, and any exports whose trigger kind is not supported, with the reason.",
  args: z.object({}),
  operation: 'list_functions_triggers',
  example: {},
  async handler(_args, ctx) {
    const discovered = await discoverFunctionsTriggers(ctx.projectDir);
    if (discovered.triggers.length === 0 && discovered.unsupported.length === 0) {
      return {
        ok: true,
        summary: `No Functions triggers found; looked for a functions source declared at ${discovered.lookedAt}.`,
        data: { triggers: [], unsupported: [] },
      };
    }
    const parts = [`${discovered.triggers.length} trigger(s)`];
    if (discovered.unsupported.length > 0) parts.push(`${discovered.unsupported.length} unsupported`);
    return {
      ok: true,
      summary: parts.join(', '),
      data: {
        triggers: discovered.triggers.map(describeTrigger),
        unsupported: discovered.unsupported,
      },
    };
  },
} satisfies MethodRecord;

/** Install a Cloud Storage rules source into the running sandbox. */
import { z } from 'zod';
import { replaceStorageRules } from 'pyric/storage/internal';
import { operationFailure } from '../context.js';
import type { OperationRecord } from '../types.js';

const parameters = z.object({
  rules: z.string().describe('Storage rules source to install.'),
});

export default {
  verb: 'set',
  service: 'storage',
  object: 'rules',
  description:
    'Install a Cloud Storage rules source into the running sandbox, replacing the ruleset in force. The rules must parse; a parse error is reported instead of being installed.',
  parameters,
  async handler(args, ctx) {
    const input = parameters.parse(args);
    try {
      await replaceStorageRules(ctx.sandbox, input.rules);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return operationFailure(
        `Storage rules did not parse: ${message}. Pass a rules source that parses, then call set again.`,
      );
    }
    return { ok: true, summary: 'Storage rules installed.' };
  },
} satisfies OperationRecord;

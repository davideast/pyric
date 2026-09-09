/** Lint a Cloud Storage rules source. */
import { z } from 'zod';
import { parseStorageRules } from 'pyric/storage';
import { operationFailure } from '../context.js';
import { activeStorageRules } from '../storage-rules.js';
import type { OperationRecord } from '../types.js';

const parameters = z.object({
  rules: z.string().optional().describe('Rules source to lint. Defaults to the rules the sandbox is running.'),
});

export default {
  verb: 'lint',
  service: 'storage',
  object: 'rules',
  description: 'Parse a Cloud Storage rules source and report the syntax and service errors it contains.',
  parameters,
  async handler(args, ctx) {
    const input = parameters.parse(args);
    const source = input.rules ?? activeStorageRules(ctx);
    if (source === null) {
      return operationFailure('No storage rules were supplied and none are loaded in the sandbox.');
    }
    try {
      parseStorageRules(source);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { ok: false, summary: message, data: { errors: [message] } };
    }
    return { ok: true, summary: 'Storage rules parsed with no errors.', data: { errors: [] } };
  },
} satisfies OperationRecord;

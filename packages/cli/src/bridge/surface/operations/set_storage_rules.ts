/**
 * Install a Cloud Storage rules source into the running sandbox.
 *
 * Storage rules are read once, by whichever call first opens the storage
 * service in a sandbox (`pyric/storage`'s `ensureService`); a later call that
 * supplies a different rules source throws rather than silently discarding it.
 * There is no reopen or re-resolution seam that lets an already-open service
 * take new rules, so this operation cannot install rules into a live sandbox.
 * It parses the source so the caller learns about a syntax error immediately,
 * then reports that the storage service must be restarted with the rules
 * file instead of guessing at a workaround.
 */
import { z } from 'zod';
import { parseStorageRules } from 'pyric/storage';
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
    'Storage rules are fixed when the storage service opens and cannot be replaced in a running sandbox; this reports that instead of installing them.',
  parameters,
  async handler(args) {
    const input = parameters.parse(args);
    try {
      parseStorageRules(input.rules);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return operationFailure(
        `Storage rules did not parse: ${message}. Pass a rules source that parses before restarting with it.`,
      );
    }
    return operationFailure(
      'Storage rules parsed, but cannot be installed into a running sandbox: the storage service reads its rules once, on the call that first opens it, and refuses a later, differing rules source rather than silently discarding it. Restart the sandbox with this rules source in the storage rules file.',
    );
  },
} satisfies OperationRecord;

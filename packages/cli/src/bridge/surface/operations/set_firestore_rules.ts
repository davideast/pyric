/** Install a Firestore rules source into the running sandbox. */
import { z } from 'zod';
import { lintFirestoreRules } from 'pyric/rules/internal';
import { setRules } from 'pyric/sandbox/firestore';
import { operationFailure } from '../context.js';
import type { OperationRecord } from '../types.js';

const parameters = z.object({
  rules: z.string().describe('Firestore rules source to install.'),
});

export default {
  verb: 'set',
  service: 'firestore',
  object: 'rules',
  description:
    'Install a Firestore rules source into the running sandbox. The rules must parse; a parse error is reported instead of being installed.',
  parameters,
  async handler(args, ctx) {
    const input = parameters.parse(args);
    const lint = lintFirestoreRules(input.rules);
    if (lint.parseError !== undefined) {
      const error = lint.parseError;
      return operationFailure(
        `Firestore rules did not parse at line ${error.line}, column ${error.column}: expected ${error.expected}. Pass a rules source that parses, then call set again.`,
      );
    }
    setRules(ctx.sandbox, input.rules);
    return { ok: true, summary: 'Firestore rules installed.' };
  },
} satisfies OperationRecord;

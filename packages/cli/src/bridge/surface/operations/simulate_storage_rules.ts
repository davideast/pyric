/** Evaluate one request against the Cloud Storage rules. */
import { z } from 'zod';
import { evaluateStorageRules, parseStorageRules } from 'pyric/storage';
import { operationFailure } from '../context.js';
import { activeStorageRules } from '../storage-rules.js';
import type { OperationRecord } from '../types.js';

const parameters = z.object({
  operation: z
    .enum(['get', 'list', 'create', 'update', 'delete', 'read', 'write'])
    .describe('The request method to evaluate.'),
  path: z.string().describe('Object path within the bucket.'),
  uid: z.string().optional().describe('Act as this user. Omit to use the held identity.'),
  rules: z.string().optional().describe('Rules source to evaluate. Defaults to the rules the sandbox is running.'),
});

export default {
  verb: 'simulate',
  service: 'storage',
  object: 'rules',
  description:
    'Evaluate one Cloud Storage request against the rules and report whether it is allowed, with the reasons.',
  parameters,
  async handler(args, ctx) {
    const input = parameters.parse(args);
    const source = input.rules ?? activeStorageRules(ctx);
    if (source === null) {
      return operationFailure('No storage rules were supplied and none are loaded in the sandbox.');
    }

    let parsed;
    try {
      parsed = parseStorageRules(source);
    } catch (error) {
      return operationFailure(error instanceof Error ? error.message : String(error));
    }

    let auth = null;
    if (input.uid !== undefined) {
      const projected = ctx.identity.projectionFor(input.uid);
      auth = { uid: projected.uid, token: projected.token };
    } else {
      const held = ctx.identity.authState();
      if (held !== null) auth = { uid: held.uid, token: held.token ?? {} };
    }

    const evaluated = evaluateStorageRules(parsed, {
      request: { auth, method: input.operation, path: input.path },
      resource: null,
    });
    return {
      ok: true,
      summary: `${input.operation} ${input.path}: ${evaluated.allowed ? 'ALLOW' : 'DENY'}`,
      data: { allowed: evaluated.allowed, reasons: evaluated.reasons },
    };
  },
} satisfies OperationRecord;

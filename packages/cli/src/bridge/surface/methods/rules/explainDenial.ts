/**
 * Trace why a request was denied, rule by rule.
 *
 * Only the Firestore engine produces an evaluation trace in this build, so the
 * validator refuses another service rather than reporting a bare verdict under
 * a method whose name promises a trace.
 */
import { z } from 'zod';
import { checkOperation, RENAMES } from '../../arguments/rules.js';
import { explainFirestoreDenial } from '../../rules-engines/firestore.js';
import { quoted } from '../../method-validation.js';
import type { MethodRecord } from '../../method-types.js';
import type { RulesRequest } from '../../rules-engines/types.js';

export default {
  tool: 'rules',
  method: 'explainDenial',
  sdkOrigin: 'pyric',
  effect: 'read',
  signature: 'explainDenial(operation, path, service?, uid?, data?)',
  description: 'Trace why a request was denied, rule by rule.',
  args: z.object({
    operation: z.string().describe('The request method that was denied.'),
    path: z.string().describe('Document path the request targets.'),
    service: z
      .string()
      .optional()
      .describe('The service whose rules denied the request. Only firestore has a trace.'),
    uid: z.string().optional().describe('Act as this user. Omit to use the held identity.'),
    data: z.record(z.unknown()).optional().describe('request.resource.data for a write.'),
  }),
  operation: 'diagnose_firestore_denial',
  renames: RENAMES,
  example: { operation: 'update', path: 'users/alice', uid: 'bob' },
  validate: (args, { fail }) => {
    const named = args.service ?? 'firestore';
    if (named !== 'firestore') {
      return fail(
        `service ${quoted(named)} has no denial trace. explainDenial reads the Firestore rules engine only in this build.`,
        `Pass service 'firestore', or call simulate for ${String(named)}.`,
        'service',
      );
    }
    return checkOperation({ ...args, service: 'firestore' }, fail);
  },
  async handler(args, ctx) {
    const request: RulesRequest = {
      operation: String(args.operation),
      path: String(args.path),
    };
    if (args.uid !== undefined) request.uid = String(args.uid);
    if (args.data !== undefined) request.data = args.data as Record<string, unknown>;
    return explainFirestoreDenial(ctx, request);
  },
} satisfies MethodRecord;

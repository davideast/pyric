/**
 * Trace why a request was denied, rule by rule.
 *
 * The Firestore engine produces an evaluation trace. The database engine
 * explains the deciding rule and the cascade it belongs to. Storage has
 * neither, so the validator refuses it rather than reporting a bare verdict
 * under a method whose name promises a trace.
 */
import { z } from 'zod';
import { checkOperation, checkRequestShape, checkRulesCompile, query, REQUEST_METHODS, RENAMES, requestMethodsOf } from '../../arguments/rules.js';
import { explainDatabaseDenial } from '../../rules-engines/database-denial.js';
import { explainFirestoreDenial } from '../../rules-engines/firestore.js';
import { quoted } from '../../closest-name.js';
import type { MethodRecord } from '../../method-types.js';
import type { RulesRequest } from '../../rules-engines/types.js';

/** The services whose engines explain a denial. */
const EXPLAINED_SERVICES = ['firestore', 'database'] as const;

export default {
  tool: 'rules',
  method: 'explainDenial',
  sdkOrigin: 'pyric',
  effect: 'read',
  signature: `explainDenial(operation: ${REQUEST_METHODS.join('|')}, path, service?: ${EXPLAINED_SERVICES.join('|')}, uid?, data?, query?, rules?, source?)`,
  description: 'Trace why a request was denied, rule by rule.',
  args: z.object({
    operation: z
      .enum(REQUEST_METHODS as [string, ...string[]])
      .describe(
        `The request method that was denied: ${REQUEST_METHODS.join(', ')}. Firestore takes ${requestMethodsOf('firestore').join(', ')}; database takes ${requestMethodsOf('database').join(', ')}, where update is a multi-path update whose patch is data.`,
      ),
    path: z
      .string()
      .describe('Document path (firestore) or tree path (database) the request targets.'),
    service: z
      .string()
      .optional()
      .describe(
        `The service whose rules denied the request: ${EXPLAINED_SERVICES.join(', ')}. Defaults to firestore.`,
      ),
    uid: z.string().optional().describe('Act as this user. Omit to use the held identity.'),
    data: z
      .unknown()
      .optional()
      .describe(
        'request.resource.data for a Firestore write, an object. For database, the value written, any JSON; for an update, the patch keyed by paths relative to path.',
      ),
    rules: z
      .string()
      .optional()
      .describe(
        'Database only: the text of a draft rules file to evaluate instead of the running ruleset. The result reports evaluated: draft and names the file line of each rule.',
      ),
    source: z
      .string()
      .optional()
      .describe(
        'Database only: the text of the rules file the running ruleset was loaded from. It adds file lines to the trace when it parses to the running ruleset, and is otherwise ignored with a note. The running ruleset is still the one evaluated.',
      ),
    query: query.optional(),
  }),
  operation: {
    ids: ['diagnose_firestore_denial', 'diagnose_database_denial'],
    select: (args) => `diagnose_${String(args.service ?? 'firestore')}_denial`,
  },
  renames: RENAMES,
  example: { operation: 'update', path: 'users/alice', uid: 'bob' },
  validate: (args, { fail }) => {
    const named = args.service ?? 'firestore';
    if (named !== 'firestore' && named !== 'database') {
      return fail(
        `service ${quoted(named)} has no denial trace. explainDenial reads the Firestore and database rules engines in this build.`,
        `Pass service 'firestore' or 'database', or call simulate for ${String(named)}.`,
        'service',
      );
    }
    for (const field of ['rules', 'source'] as const) {
      if (named === 'firestore' && args[field] !== undefined) {
        return fail(
          `${field} is read for service 'database' only.`,
          `Drop ${field}, or pass service 'database'.`,
          field,
        );
      }
    }
    if (args.rules !== undefined && args.source !== undefined) {
      return fail(
        'rules and source are two different questions: rules evaluates a draft, source only adds file lines to the running ruleset.',
        'Pass one of them.',
        'source',
      );
    }
    const shape = checkRequestShape({ ...args, service: named }, fail);
    if (shape) return shape;
    // A draft production would refuse at deploy is refused here with the same
    // message, rather than explained as if it could be loaded.
    if (args.rules !== undefined) {
      const refused = checkRulesCompile({ ...args, service: named }, fail);
      if (refused) return refused;
    }
    return checkOperation({ ...args, service: named }, fail);
  },
  async handler(args, ctx) {
    if (args.service === 'database') {
      return explainDatabaseDenial(ctx, {
        operation: String(args.operation),
        path: String(args.path),
        ...(args.uid !== undefined ? { uid: String(args.uid) } : {}),
        ...(args.data !== undefined ? { data: args.data } : {}),
        ...(args.rules !== undefined ? { rules: String(args.rules) } : {}),
        ...(args.source !== undefined ? { source: String(args.source) } : {}),
        ...(args.query !== undefined ? { query: args.query as Record<string, unknown> } : {}),
      });
    }
    const request: RulesRequest = {
      operation: String(args.operation),
      path: String(args.path),
    };
    if (args.uid !== undefined) request.uid = String(args.uid);
    if (args.data !== undefined) request.data = args.data as Record<string, unknown>;
    return explainFirestoreDenial(ctx, request);
  },
} satisfies MethodRecord;

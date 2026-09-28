/** The Cloud Storage rules engine behind the `rules` tool. */
import { evaluateStorageRules, parseStorageRules, ref } from 'pyric/storage';
import type { StorageRequestMethod } from 'pyric/storage';
import {
  getStorageCrossServiceIam,
  replaceStorageRules,
  storageFirestoreLookup,
} from 'pyric/storage/internal';
import { asSentence } from 'pyric/sandbox/internal';
import { describeCompileLimitViolations, sourceCompileLimitViolations } from 'pyric/rules/internal';
import { operationFailure } from '../context.js';
import { requestInstant } from '../request-instant.js';
import { storageFor } from '../service-handles.js';
import { activeStorageRules, rulesRequestPath } from '../storage-rules.js';
import type { SurfaceContext } from '../types.js';
import { markLintFindings } from '../rules-verdict.js';
import type { RulesEngine, RulesSourceProblem } from './types.js';

/** What a call has to do when it named no source and the sandbox holds none. */
const NO_RULES_LOADED =
  "No storage rules were supplied and none are loaded in the sandbox. Pass rules, or call rules.set with service 'storage' first.";

/** The identity a simulation runs as, in the shape the rules evaluator takes. */
function identityFor(
  ctx: SurfaceContext,
  uid: string | undefined,
): { uid: string; token: Record<string, unknown> } | null {
  if (uid !== undefined) {
    const projected = ctx.identity.projectionFor(uid);
    return { uid: projected.uid, token: projected.token };
  }
  const held = ctx.identity.authState();
  if (held === null) return null;
  return { uid: held.uid, token: held.token ?? {} };
}

/**
 * Why `parseStorageRules` refused a source: production's compile rejections
 * when the source parses and breaks a compile limit, otherwise the failure it
 * threw.
 */
function sourceProblem(source: string, error: unknown): RulesSourceProblem {
  const violations = sourceCompileLimitViolations(source);
  if (violations.length > 0) {
    return {
      body: `rules did not compile: ${describeCompileLimitViolations(violations)}`,
      fix: "Bring the ruleset within production's compile limits, then call rules.set with service 'storage'.",
    };
  }
  const message = error instanceof Error ? error.message : String(error);
  return {
    body: asSentence(`rules did not parse: ${message}`),
    fix: "Fix the syntax, then call rules.set with service 'storage'.",
  };
}

export const STORAGE_RULES: RulesEngine = {
  requestMethods: ['get', 'list', 'create', 'update', 'delete', 'read', 'write'],

  compileFailure(source): RulesSourceProblem | null {
    try {
      parseStorageRules(source);
      return null;
    } catch (error) {
      return sourceProblem(source, error);
    }
  },

  async lint(ctx, rules) {
    const source = rules ?? activeStorageRules(ctx);
    if (source === null) {
      return operationFailure(NO_RULES_LOADED);
    }
    try {
      parseStorageRules(source);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return markLintFindings({
        ok: false,
        summary: `${message} ${sourceProblem(source, error).fix}`,
        data: { errors: [message] },
      });
    }
    return { ok: true, summary: 'Storage rules parsed with no errors.', data: { errors: [] } };
  },

  async simulate(ctx, request) {
    const source = request.rules ?? activeStorageRules(ctx);
    if (source === null) {
      return operationFailure(NO_RULES_LOADED);
    }

    let parsed;
    try {
      parsed = parseStorageRules(source);
    } catch (error) {
      return operationFailure(error instanceof Error ? error.message : String(error));
    }

    const object = ref(storageFor(ctx), request.path);
    const evaluated = evaluateStorageRules(
      parsed,
      {
        request: {
          auth: identityFor(ctx, request.uid),
          method: request.operation as StorageRequestMethod,
          path: rulesRequestPath(object),
        },
        resource: null,
      },
      new Date(requestInstant(ctx, request.requestTime)),
      // A rule reaching into Firestore is answered here the way the
      // enforcement path answers it, under the posture the sandbox is in, so a
      // simulation predicts the operation rather than a neighbouring one.
      storageFirestoreLookup(ctx.sandbox, getStorageCrossServiceIam(ctx.sandbox)),
    );
    return {
      ok: true,
      summary: `${request.operation} ${request.path}: ${evaluated.allowed ? 'ALLOW' : 'DENY'}`,
      data: { allowed: evaluated.allowed, reasons: evaluated.reasons },
    };
  },

  async install(ctx, rules) {
    try {
      await replaceStorageRules(ctx.sandbox, rules);
    } catch (error) {
      const problem = sourceProblem(rules, error);
      return operationFailure(`Storage ${problem.body} ${problem.fix}`);
    }
    return { ok: true, summary: 'Storage rules installed.' };
  },
};

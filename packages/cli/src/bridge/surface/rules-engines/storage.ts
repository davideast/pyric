/** The Cloud Storage rules engine behind the `rules` tool. */
import { evaluateStorageRules, parseStorageRules, ref } from 'pyric/storage';
import type { StorageRequestMethod } from 'pyric/storage';
import { replaceStorageRules } from 'pyric/storage/internal';
import { operationFailure } from '../context.js';
import { storageFor } from '../service-handles.js';
import { activeStorageRules, rulesRequestPath } from '../storage-rules.js';
import type { SurfaceContext } from '../types.js';
import type { RulesEngine, RulesSourceProblem } from './types.js';

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

export const STORAGE_RULES: RulesEngine = {
  requestMethods: ['get', 'list', 'create', 'update', 'delete', 'read', 'write'],

  parseFailure(source): RulesSourceProblem | null {
    try {
      parseStorageRules(source);
      return null;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        body: `rules did not parse: ${message}.`,
        fix: 'Pass a rules source that parses, then call set again.',
      };
    }
  },

  async lint(ctx, rules) {
    const source = rules ?? activeStorageRules(ctx);
    if (source === null) {
      return operationFailure(
        'No storage rules were supplied and none are loaded in the sandbox.',
      );
    }
    try {
      parseStorageRules(source);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { ok: false, summary: message, data: { errors: [message] } };
    }
    return { ok: true, summary: 'Storage rules parsed with no errors.', data: { errors: [] } };
  },

  async simulate(ctx, request) {
    const source = request.rules ?? activeStorageRules(ctx);
    if (source === null) {
      return operationFailure(
        'No storage rules were supplied and none are loaded in the sandbox.',
      );
    }

    let parsed;
    try {
      parsed = parseStorageRules(source);
    } catch (error) {
      return operationFailure(error instanceof Error ? error.message : String(error));
    }

    const object = ref(storageFor(ctx), request.path);
    const evaluated = evaluateStorageRules(parsed, {
      request: {
        auth: identityFor(ctx, request.uid),
        method: request.operation as StorageRequestMethod,
        path: rulesRequestPath(object),
      },
      resource: null,
    });
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
      const message = error instanceof Error ? error.message : String(error);
      return operationFailure(
        `Storage rules did not parse: ${message}. Pass a rules source that parses, then call set again.`,
      );
    }
    return { ok: true, summary: 'Storage rules installed.' };
  },
};

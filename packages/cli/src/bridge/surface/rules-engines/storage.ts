/** The Cloud Storage rules engine behind the `rules` tool. */
import { evaluateStorageRules, ref } from 'pyric/storage';
import type { StorageReference, StorageRequestMethod } from 'pyric/storage';
import {
  compileStorageRules,
  getStorageCrossServiceIam,
  getStorageService,
  replaceStorageRules,
  requestResourceFor,
  resourceFromStored,
  storageFirestoreLookup,
  type StoredMetadata,
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

function requestResourceFromData(
  object: StorageReference,
  operation: string,
  data: unknown,
  existing: StoredMetadata | undefined,
) {
  if (data === undefined || typeof data !== 'object' || data === null || Array.isArray(data)) {
    return undefined;
  }
  const raw = data as Record<string, unknown>;
  const writeKind = operation === 'update' ? 'metadataUpdate' : 'upload';
  const customMetadata =
    raw.metadata !== undefined &&
    typeof raw.metadata === 'object' &&
    raw.metadata !== null &&
    !Array.isArray(raw.metadata)
      ? (raw.metadata as Record<string, string>)
      : raw.customMetadata !== undefined &&
          typeof raw.customMetadata === 'object' &&
          raw.customMetadata !== null &&
          !Array.isArray(raw.customMetadata)
        ? (raw.customMetadata as Record<string, string>)
        : existing?.customMetadata;
  const base = requestResourceFor(
    {
      fullPath: typeof raw.name === 'string' ? raw.name : object.fullPath,
      bucket: typeof raw.bucket === 'string' ? raw.bucket : object.bucket,
      size: typeof raw.size === 'number' ? raw.size : (existing?.size ?? 0),
      contentType:
        typeof raw.contentType === 'string'
          ? raw.contentType
          : (existing?.contentType ?? 'application/octet-stream'),
      customMetadata,
      cacheControl: typeof raw.cacheControl === 'string' ? raw.cacheControl : existing?.cacheControl,
      contentDisposition:
        typeof raw.contentDisposition === 'string'
          ? raw.contentDisposition
          : existing?.contentDisposition,
      contentEncoding:
        typeof raw.contentEncoding === 'string' ? raw.contentEncoding : existing?.contentEncoding,
      contentLanguage:
        typeof raw.contentLanguage === 'string' ? raw.contentLanguage : existing?.contentLanguage,
      generation:
        typeof raw.generation === 'number' || typeof raw.generation === 'string'
          ? String(raw.generation)
          : existing?.generation,
      metageneration:
        typeof raw.metageneration === 'number' || typeof raw.metageneration === 'string'
          ? String(raw.metageneration)
          : existing?.metageneration,
    },
    writeKind,
  );
  if (raw.metadata === null || raw.customMetadata === null) base.metadata = null;
  if (raw.contentDisposition === null) base.contentDisposition = null;
  if (raw.contentEncoding === null) base.contentEncoding = null;
  if (raw.contentLanguage === null) base.contentLanguage = null;
  if (raw.cacheControl === null) base.cacheControl = null;
  if (typeof raw.generation === 'number' || raw.generation === null) base.generation = raw.generation;
  if (typeof raw.metageneration === 'number' || raw.metageneration === null) {
    base.metageneration = raw.metageneration;
  }
  if (raw.etag === null) base.etag = null;
  return base;
}

/**
 * Why `compileStorageRules` refused a source: production's compile rejections
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
      compileStorageRules(source);
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
      compileStorageRules(source);
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
      parsed = compileStorageRules(source).rules;
    } catch (error) {
      return operationFailure(error instanceof Error ? error.message : String(error));
    }

    const object = ref(storageFor(ctx), request.path);
    const service = await getStorageService(object.storage);
    const existing = object.fullPath
      ? await service.backend.getMetadata(object.fullPath, object.bucket)
      : undefined;
    const requestResource = requestResourceFromData(
      object,
      request.operation,
      request.data,
      existing,
    );
    const evaluated = evaluateStorageRules(
      parsed,
      {
        request: {
          auth: identityFor(ctx, request.uid),
          method: request.operation as StorageRequestMethod,
          path: rulesRequestPath(object),
          ...(requestResource !== undefined ? { resource: requestResource } : {}),
        },
        resource: resourceFromStored(existing),
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

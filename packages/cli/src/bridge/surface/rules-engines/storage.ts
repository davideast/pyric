/** The Cloud Storage rules engine behind the `rules` tool. */
import { evaluateStorageRules, ref } from 'pyric/storage';
import type { StorageReference, StorageRequestMethod } from 'pyric/storage';
import {
  compileStorageRules,
  getStorageCrossServiceIam,
  getStorageService,
  bindRulesBucket,
  replaceStorageRules,
  resourceFromStored,
  rulesBucketName,
  storageFirestoreLookup,
} from 'pyric/storage/internal';
import { asSentence } from 'pyric/sandbox/internal';
import { lint as lintRules, type RuleIssue } from 'pyric/rules';
import { describeCompileLimitViolations, sourceCompileLimitViolations } from 'pyric/rules/internal';
import { operationFailure } from '../context.js';
import { requestInstant } from '../request-instant.js';
import { storageFor } from '../service-handles.js';
import { activeStorageRules } from '../storage-rules.js';
import type { OperationResult, SurfaceContext } from '../types.js';
import { markLintFindings } from '../rules-verdict.js';
import { simulatedRequestResource } from './storage-request-resource.js';
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

/** The bucket a case's data names, which is the name its rules see. */
function caseBucketName(data: unknown): string | undefined {
  if (data === null || typeof data !== 'object') return undefined;
  const bucket = (data as { bucket?: unknown }).bucket;
  return typeof bucket === 'string' && bucket !== '' ? bucket : undefined;
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

/** One finding as a line: its code, where it is, and what it says. */
function findingLine(issue: RuleIssue): string {
  const where = issue.path === undefined ? '' : ` at ${issue.path}`;
  return `${issue.code}${where}: ${issue.message}`;
}

/**
 * A compiled source's lint result. An error-severity finding fails the lint,
 * as a security hole or a construct production reads differently is a reason
 * not to deploy; warnings alone pass, and are listed.
 */
function lintResult(issues: RuleIssue[]): OperationResult {
  const errors = issues.filter((issue) => issue.severity === 'error');
  const warnings = issues.filter((issue) => issue.severity !== 'error');
  const warningNote =
    warnings.length === 0 ? '' : ` Warnings: ${warnings.map((issue) => issue.code).join(', ')}.`;
  const data = { errors: errors.map(findingLine), issues };
  if (errors.length > 0) {
    return markLintFindings({
      ok: false,
      summary: `Storage rules lint found ${errors.length} error(s). ${errors.map(findingLine).join(' ')}${warningNote}`,
      data,
    });
  }
  return { ok: true, summary: `Storage rules compiled with no lint errors.${warningNote}`, data };
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
    // The shared linter is what `lint()` from `pyric/rules` runs, so both
    // report the same findings for one source.
    const issues = lintRules(source);
    try {
      compileStorageRules(source);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return markLintFindings({
        ok: false,
        summary: `${message} ${sourceProblem(source, error).fix}`,
        data: { errors: [message], issues },
      });
    }
    return lintResult(issues);
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
    const bucketName = rulesBucketName(object.bucket, caseBucketName(request.data) ?? ctx.storageBucketName?.());
    const service = await getStorageService(object.storage);
    const existing = object.fullPath
      ? await service.backend.getMetadata(object.fullPath, object.bucket)
      : undefined;
    const built = simulatedRequestResource(object, request.operation, request.data, existing);
    if (!built.ok) {
      return operationFailure(`${request.operation} ${request.path}: ${built.reason}`);
    }
    const requestResource = built.resource;
    // Rules see the bucket under the name the app knows it by, as the live
    // planes bind it (ST-H2-4).
    const input = bindRulesBucket(
      {
        request: {
          auth: identityFor(ctx, request.uid),
          method: request.operation as StorageRequestMethod,
          path: object.fullPath,
          ...(requestResource !== undefined ? { resource: requestResource } : {}),
        },
        resource: resourceFromStored(existing),
      },
      object.bucket,
      bucketName,
    );
    const evaluated = evaluateStorageRules(
      parsed,
      input,
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

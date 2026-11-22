/**
 * The Cloud Firestore database a `firestore` or `rules` method call selects.
 *
 * `database` follows Firebase's naming: absent or `'(default)'` selects the
 * default database with byte-identical `(default)` summaries, while any other
 * id targets that declared named database on `ctx.sandbox`.
 */
import { z } from 'zod';
import { createFirestoreDataTools } from 'pyric/firestore';
import {
  DEFAULT_FIRESTORE_DATABASE,
  isFirestoreDatabaseDeclared,
  isValidFirestoreDatabaseId,
  listDeclaredFirestoreDatabases,
  missingFirestoreDatabaseNotFoundMessage,
} from 'pyric/firestore/internal';
import { quoted } from './closest-name.js';
import type { Args, Fail, InvalidArguments } from './method-types.js';
import { callSandboxTool } from './sandbox-context.js';
import { firestoreFor } from './service-handles.js';
import type { OperationResult, SandboxSurfaceContext } from './types.js';

export const databaseArgument = z
  .string()
  .optional()
  .describe("Firestore database id. Omit or '(default)' targets the default database.");

/** Normalize a `database` argument to `undefined` for `(default)` or the named id. */
export function firestoreDatabaseSelector(raw: unknown): string | undefined {
  if (raw === undefined) return undefined;
  const value = String(raw);
  if (value === '' || value === DEFAULT_FIRESTORE_DATABASE) return undefined;
  return value;
}

/** Validate an optional `database` argument on Firestore data and structure methods. */
export function checkFirestoreDatabase(args: Args, fail: Fail): InvalidArguments | null {
  if (args.database === undefined) return null;
  if (typeof args.database !== 'string' || args.database.length === 0 || args.database.length > 256) {
    return fail(
      `database ${quoted(args.database)} is not a valid Firestore database id.`,
      "Pass database as '(default)' or a non-empty database id of at most 256 characters.",
      'database',
    );
  }
  return null;
}

/** Validate `database` on multi-service `rules.*` methods, including naming rules on `rules.set`. */
export function checkRulesFirestoreDatabase(
  args: Args,
  fail: Fail,
  serviceOverride?: unknown,
  requireDeclarationRule = false,
): InvalidArguments | null {
  if (args.database === undefined) return null;
  const targetService = serviceOverride ?? args.service;
  if (targetService !== 'firestore') {
    return fail(
      `database is read for service 'firestore' only, not ${quoted(targetService)}.`,
      "Drop database, or pass service 'firestore' (use instance for database or bucket for storage).",
      'database',
    );
  }
  const basic = checkFirestoreDatabase(args, fail);
  if (basic !== null) return basic;
  const selector = firestoreDatabaseSelector(args.database);
  if (requireDeclarationRule && selector !== undefined && !isValidFirestoreDatabaseId(selector)) {
    return fail(
      `database ${quoted(args.database)} does not match Firestore's database naming rule.`,
      "Pass '(default)' or a 4-63 character lowercase id of letters, digits, and hyphens starting with a letter and not ending with a hyphen.",
      'database',
    );
  }
  return null;
}

/** Assert that a named database is declared in `ctx.sandbox`, throwing C3 `NOT_FOUND` with known databases when missing. */
export function assertDeclaredFirestoreDatabase(
  ctx: SandboxSurfaceContext,
  selector: string | undefined,
): void {
  if (selector === undefined) return;
  if (isFirestoreDatabaseDeclared(ctx.sandbox, selector)) return;
  const declared = [DEFAULT_FIRESTORE_DATABASE, ...listDeclaredFirestoreDatabases(ctx.sandbox)];
  const base = missingFirestoreDatabaseNotFoundMessage(selector, 'pyric').trimEnd();
  throw new Error(`${base} Known databases: ${declared.join(', ')}.`);
}

/** Append `on <database>` when `selector` names a non-default database; leave `(default)` unchanged. */
export function onFirestoreDatabase(summary: string, selector: string | undefined): string {
  if (selector === undefined) return summary;
  return `${summary} on ${selector}`;
}

/**
 * Execute a `createFirestoreDataTools` handler: `(default)` goes through
 * `callSandboxTool` byte-identically, while named databases run directly
 * against `firestoreFor(ctx, selector)`.
 */
export async function callFirestoreSandboxTool(
  ctx: SandboxSurfaceContext,
  toolName: string,
  toolArgs: Record<string, unknown>,
  selector: string | undefined,
): Promise<OperationResult> {
  if (selector === undefined) {
    return callSandboxTool(ctx, toolName, toolArgs);
  }
  assertDeclaredFirestoreDatabase(ctx, selector);
  const handlers = createFirestoreDataTools({
    resolveDb: (_as, dbId) => firestoreFor(ctx, dbId ?? selector),
  });
  const handler = handlers.find((entry) => entry.name === toolName);
  if (handler === undefined) {
    throw new Error(`Unknown Firestore tool '${toolName}'.`);
  }
  const result = await handler.execute(
    { ...toolArgs, database: selector },
    { signal: new AbortController().signal } as never,
  );
  const out: OperationResult = {
    ok: result.ok,
    summary: onFirestoreDatabase(result.summary, selector),
  };
  if (result.data !== undefined) {
    out.data = result.data;
  }
  return out;
}

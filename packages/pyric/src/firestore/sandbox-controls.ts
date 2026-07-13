/**
 * Firestore-specific controls for the public `pyric/sandbox/firestore`
 * subpath.
 *
 * The implementation stays with the Firestore module even though the package
 * export is nested below `pyric/sandbox`: central sandbox owns cross-service
 * lifecycle, while each Firebase surface owns its own backend controls.
 */
import {
  isRemoteSandbox,
  SandboxError,
  type Sandbox,
} from 'pyric/sandbox';
import { getInternalEnv } from 'pyric/sandbox/internal';
import { lintFirestoreRules } from 'pyric/rules/internal';

import type { DocumentData, LintResult } from './types.js';

export interface FirestoreInspectOptions {
  /** Maximum number of recent requests and denials to return. Defaults to 10. */
  recentEventLimit?: number;
}

/** Stable JSON-serializable Firestore diagnostic used by Studio and tools. */
export interface FirestoreInspectReport {
  rules: {
    source: string;
    sizeBytes: number;
    isEmpty: boolean;
    lint: {
      errors: number;
      warnings: number;
      info: number;
      findings: Array<{ rule: string; severity: string; message: string }>;
    };
  };
  documents: {
    totalCount: number;
    byCollection: Record<string, number>;
  };
  events: {
    totalCount: number;
    recentDenials: Array<{
      path: string;
      method: string;
      auth: unknown;
      debugMessage?: string;
    }>;
    recentRequests: Array<{
      path: string;
      method: string;
      result: string;
      auth: unknown;
    }>;
  };
}

function syncOnlyRemotely(operation: string, remediation: string): never {
  throw new SandboxError({
    code: 'unimplemented',
    message:
      `${operation} is not available on a remote sandbox because its return `
      + 'value is synchronous and the data lives in the browser worker.',
    remediation,
  });
}

/** Load Firestore Rules into one sandbox and notify its live listeners. */
export function setRules(sandbox: Sandbox, source: string): LintResult {
  if (isRemoteSandbox(sandbox)) {
    return syncOnlyRemotely(
      'setRules',
      "Deploy rules asynchronously through the relay instead: `await sandbox.channel.op({ method: 'setFirestoreRules', source })`.",
    );
  }
  return getInternalEnv(sandbox).deployRules(source);
}

/** Replace Firestore documents in bulk, preserving rules and bypassing evaluation. */
export function seedDocuments(
  sandbox: Sandbox,
  documents: Record<string, DocumentData>,
): LintResult {
  if (isRemoteSandbox(sandbox)) {
    return syncOnlyRemotely(
      'seedDocuments',
      'The relay has no atomic seed operation. Write seed documents through '
        + "`sandbox.channel.op({ method: 'admin.setDocument', path, data })` per document.",
    );
  }
  const env = getInternalEnv(sandbox);
  return env.seed({ rules: env.getRules(), documents });
}

/** Inspect Firestore rules, documents, and recent requests in one sandbox. */
export function inspect(
  sandbox: Sandbox,
  options: FirestoreInspectOptions = {},
): FirestoreInspectReport {
  if (isRemoteSandbox(sandbox)) {
    return syncOnlyRemotely(
      'inspect',
      "Read worker state asynchronously through `await sandbox.channel.op({ method: 'admin.readState' })`; use the relay rules and event tools for the remaining diagnostic fields.",
    );
  }

  const recentLimit = options.recentEventLimit ?? 10;
  const env = getInternalEnv(sandbox);
  const rulesSource = env.getRules();
  const lint = rulesSource ? lintFirestoreRules(rulesSource) : { warnings: [] };
  const findings = lint.warnings.map((warning) => ({
    rule: warning.rule,
    severity: warning.severity,
    message: warning.message,
  }));
  const counts = { errors: 0, warnings: 0, info: 0 };
  for (const warning of lint.warnings) {
    if (warning.severity === 'error') counts.errors++;
    else if (warning.severity === 'warning') counts.warnings++;
    else counts.info++;
  }

  const documents = env.snapshot();
  const byCollection: Record<string, number> = {};
  for (const path of Object.keys(documents)) {
    const top = path.split('/')[0] ?? '';
    if (!top) continue;
    byCollection[top] = (byCollection[top] ?? 0) + 1;
  }

  const history = sandbox.history() as unknown as Array<Record<string, unknown>>;
  const requests = history.filter((event) => event.kind === 'request');
  const denials = requests.filter((event) => event.result === 'deny');
  const recentRequests = requests.slice(-recentLimit).map((event) => ({
    path: String(event.path ?? ''),
    method: String(event.method ?? ''),
    result: String(event.result ?? ''),
    auth: event.auth ?? null,
  }));
  const recentDenials = denials.slice(-recentLimit).map((event) => ({
    path: String(event.path ?? ''),
    method: String(event.method ?? ''),
    auth: event.auth ?? null,
    debugMessage:
      typeof event.debugMessage === 'string' ? event.debugMessage : undefined,
  }));

  return {
    rules: {
      source: rulesSource,
      sizeBytes: new TextEncoder().encode(rulesSource).byteLength,
      isEmpty: rulesSource.trim().length === 0,
      lint: { ...counts, findings },
    },
    documents: {
      totalCount: Object.keys(documents).length,
      byCollection,
    },
    events: {
      totalCount: history.length,
      recentDenials,
      recentRequests,
    },
  };
}

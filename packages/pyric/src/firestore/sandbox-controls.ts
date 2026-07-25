/**
 * Firestore-specific controls for the public `pyric/sandbox/firestore`
 * subpath.
 *
 * The implementation stays with the Firestore module even though the package
 * export is nested below `pyric/sandbox`: central sandbox owns cross-service
 * lifecycle, while each Firebase surface owns its own backend controls.
 */
import type { LocalSandbox, RemoteSandbox } from 'pyric/sandbox';
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

/** Load Firestore Rules into one sandbox and notify its live listeners. */
export function setRules(sandbox: LocalSandbox, source: string): LintResult {
  return getInternalEnv(sandbox).deployRules(source);
}

/** Replace Firestore documents in bulk, preserving rules and bypassing evaluation. */
export function seedDocuments(
  sandbox: LocalSandbox,
  documents: Record<string, DocumentData>,
): LintResult {
  const env = getInternalEnv(sandbox);
  return env.seed({ rules: env.getRules(), documents });
}

/** Snapshot only Firestore documents without traversing other sandbox services. */
export function snapshotDocuments(
  sandbox: LocalSandbox,
): Record<string, DocumentData> {
  return getInternalEnv(sandbox).snapshot();
}

/** Inspect Firestore rules, documents, and recent requests in one sandbox. */
export function inspect(
  sandbox: LocalSandbox,
  options: FirestoreInspectOptions = {},
): FirestoreInspectReport {
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
  const operations: Array<Record<string, unknown>> = [];
  for (const event of history) {
    const isRequestKind = event.kind === 'request';
    const isOperationKind = event.kind === 'operation';
    const isListenerKind = event.kind === 'listener';
    if (isRequestKind) {
      operations.push(event);
    } else if (isOperationKind) {
      operations.push(event);
    } else if (isListenerKind) {
      const isErroredPhase = event.phase === 'errored';
      if (isErroredPhase) {
        operations.push(event);
      }
    }
  }
  const denials: Array<Record<string, unknown>> = [];
  for (const event of operations) {
    const isDenyResult = event.result === 'deny';
    if (isDenyResult) {
      denials.push(event);
    } else {
      const errorObj = event.error as Record<string, unknown> | undefined;
      const hasPermissionDeniedCode = errorObj !== undefined && errorObj.code === 'PERMISSION_DENIED';
      if (hasPermissionDeniedCode) {
        denials.push(event);
      }
    }
  }
  const recentRequests = operations.slice(-recentLimit).map((event) => {
    let pathVal = '';
    if (event.path !== undefined) {
      pathVal = String(event.path);
    } else {
      const targetObj = event.target as Record<string, unknown> | undefined;
      if (targetObj !== undefined && targetObj.path !== undefined) {
        pathVal = String(targetObj.path);
      }
    }
    let methodVal = 'listen';
    if (event.method !== undefined) {
      methodVal = String(event.method);
    }
    let resultVal = 'error';
    if (event.result !== undefined) {
      resultVal = String(event.result);
    } else {
      const errorObj = event.error as Record<string, unknown> | undefined;
      if (errorObj !== undefined && errorObj.code === 'PERMISSION_DENIED') {
        resultVal = 'deny';
      }
    }
    let authVal: unknown = null;
    if (event.auth !== undefined) {
      authVal = event.auth;
    }
    return {
      path: pathVal,
      method: methodVal,
      result: resultVal,
      auth: authVal,
    };
  });
  const recentDenials = denials.slice(-recentLimit).map((event) => {
    let pathVal = '';
    if (event.path !== undefined) {
      pathVal = String(event.path);
    } else {
      const targetObj = event.target as Record<string, unknown> | undefined;
      if (targetObj !== undefined && targetObj.path !== undefined) {
        pathVal = String(targetObj.path);
      }
    }
    let methodVal = 'listen';
    if (event.method !== undefined) {
      methodVal = String(event.method);
    }
    let authVal: unknown = null;
    if (event.auth !== undefined) {
      authVal = event.auth;
    }
    let debugMessageVal: string | undefined = undefined;
    if (typeof event.debugMessage === 'string') {
      debugMessageVal = event.debugMessage;
    }
    return {
      path: pathVal,
      method: methodVal,
      auth: authVal,
      debugMessage: debugMessageVal,
    };
  });

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

type Assert<T extends true> = T;
type RemoteSandboxIsRejectedByControls = Assert<
  RemoteSandbox extends Parameters<typeof setRules>[0] ? false : true
>;

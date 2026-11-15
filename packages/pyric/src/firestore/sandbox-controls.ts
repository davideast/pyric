/**
 * Firestore-specific controls for the public `pyric/sandbox/firestore`
 * subpath.
 *
 * The implementation stays with the Firestore module even though the package
 * export is nested below `pyric/sandbox`: central sandbox owns cross-service
 * lifecycle, while each Firebase surface owns its own backend controls.
 */
import {
  isOperationEvent,
  toOperationRecord,
  type LocalSandbox,
  type OperationRecord,
  type RemoteSandbox,
  type SandboxEvent,
} from 'pyric/sandbox';
import { getInternalEnv } from 'pyric/sandbox/internal';
import { lintFirestoreRules, rulesSourceRejection } from 'pyric/rules/internal';
import { markUserWriteValue, stripUnescapedUserMapTag } from './sandbox/unescaped-map.js';

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
      rule?: unknown;
      reasons?: string[];
      evidenceExpired?: true;
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
  const markedDocuments: Record<string, DocumentData> = {};
  for (const [path, docData] of Object.entries(documents)) {
    Object.defineProperty(markedDocuments, path, {
      value: markUserWriteValue(docData) as DocumentData,
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  return env.seed({ rules: env.getRules(), documents: markedDocuments });
}

/** Snapshot only Firestore documents without traversing other sandbox services. */
export function snapshotDocuments(
  sandbox: LocalSandbox,
): Record<string, DocumentData> {
  const raw = getInternalEnv(sandbox).snapshot();
  const out: Record<string, DocumentData> = {};
  for (const [path, docData] of Object.entries(raw)) {
    Object.defineProperty(out, path, {
      value: stripUnescapedUserMapTag(docData) as DocumentData,
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  return out;
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
  // `setRules` installs a source production would not load. Its status
  // carries the reason the CLI's rules load paths refuse the same source with.
  const rejection = rulesSource ? rulesSourceRejection(rulesSource) : null;
  if (rejection !== null) {
    findings.unshift({
      rule: rejection.kind === 'parse' ? 'PARSE_ERROR' : 'COMPILE_LIMIT',
      severity: 'error',
      message: `Firestore ${rejection.message}`,
    });
    counts.errors++;
  }

  const documents = env.snapshot();
  const byCollection: Record<string, number> = {};
  for (const path of Object.keys(documents)) {
    const top = path.split('/')[0] ?? '';
    if (!top) continue;
    byCollection[top] = (byCollection[top] ?? 0) + 1;
  }

  const history = sandbox.history();
  const operations: Array<{ event: SandboxEvent; record: OperationRecord }> = [];
  for (const event of history) {
    if (!isOperationEvent(event)) continue;
    const record = toOperationRecord(event);
    if (record !== null) {
      operations.push({ event, record });
    }
  }
  const denials = operations.filter(
    ({ record }) => record.denial !== undefined || record.result === 'deny',
  );
  const recentRequests = operations.slice(-recentLimit).map(({ record }) => ({
    path: record.path ?? '',
    method: record.method,
    result: record.result ?? 'error',
    auth: record.auth,
  }));
  const recentDenials = denials.slice(-recentLimit).map(({ event, record }) => {
    const rawDebug = (event as { debugMessage?: unknown }).debugMessage;
    const debugMessageVal = typeof rawDebug === 'string' ? rawDebug : undefined;
    let ruleVal: unknown = record.denial?.rule;
    if (event.kind === 'request' && event.evaluatedRule !== undefined) {
      ruleVal = event.evaluatedRule;
    }
    let reasonsVal: string[] | undefined = undefined;
    if (record.denial !== undefined) {
      reasonsVal = [...record.denial.reasons];
    } else if (debugMessageVal !== undefined) {
      reasonsVal = [debugMessageVal];
    }
    const entry: FirestoreInspectReport['events']['recentDenials'][number] = {
      path: record.path ?? '',
      method: record.method,
      auth: record.auth,
      debugMessage: debugMessageVal,
      rule: ruleVal,
      reasons: reasonsVal,
    };
    if (record.denial?.evidenceExpired === true) {
      entry.evidenceExpired = true;
    }
    return entry;
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

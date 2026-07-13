/** Cross-service diagnostic for one sandbox runtime. */
import { lintFirestoreRules } from 'pyric/rules/internal';

import { getInternalEnv } from './internal/sandbox-impl.js';
import type { Sandbox } from './types/service.js';

export interface InspectSandboxOptions {
  /** Maximum number of recent requests and denials to return. Defaults to 10. */
  recentEventLimit?: number;
}

/** Stable JSON-serializable shape used by Studio and the sandbox inspect tool. */
export interface SandboxInspect {
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

/**
 * Inspect the state owned by a sandbox without routing through any Firebase
 * service handle. The diagnostic is cross-service infrastructure even though
 * its first stable fields describe Firestore state and rules.
 */
export function inspectSandbox(
  sandbox: Sandbox,
  options: InspectSandboxOptions = {},
): SandboxInspect {
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

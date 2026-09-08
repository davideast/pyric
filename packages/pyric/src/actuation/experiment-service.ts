/**
 * Pure domain service for sandbox branching & regression experiments (`dryRunExperiment`),
 * AST expression failure tracing (`diagnoseRuleDenial`), and security rules verification
 * (`verifySecurityRules`).
 */

import {
  fork,
  apply,
  diff,
  promote,
  discard,
  toOperationRecord,
  type Branch,
  type Divergence,
  type LocalSandbox,
  type SandboxEvent,
} from 'pyric/sandbox';
import { getInternalEnv } from 'pyric/sandbox/internal';
import { setRules } from 'pyric/sandbox/firestore';
import { getActiveRules, snapshotState } from 'pyric/sandbox/database';
import {
  firestoreRules,
  rtdbRules,
  lint as lintRules,
  type ExprTraceEntry,
  type FirestoreCase,
  type RtdbCase,
  type RuleIssue,
  type FirestoreMethod,
} from 'pyric/rules';
import { getActiveIdentityLens, buildNormalizedClaims } from './auth-service.js';
import { canonicalizePath } from '../sandbox/internal/index.js';

export interface RuleRegression {
  path: string;
  operation: string;
  authUid?: string | null;
  previousDecision: 'ALLOW';
  candidateDecision: 'DENY';
  reason: string;
}

export interface DryRunExperimentInput {
  action: 'fork' | 'apply' | 'diff' | 'promote' | 'discard';
  branchId?: string;
  candidateRules?: string;
  mutationsJson?: string;
  events?: SandboxEvent[];
  force?: boolean;
}

export interface DryRunExperimentOutput {
  ok: boolean;
  action: DryRunExperimentInput['action'];
  branchId: string;
  status: 'forked' | 'applied' | 'diffed' | 'promoted' | 'discarded' | 'rejected';
  divergences: Divergence[];
  regressions: RuleRegression[];
  error?: string;
}

const branchesBySandbox = new WeakMap<LocalSandbox, Map<string, Branch>>();

function getBranchMap(sandbox: LocalSandbox): Map<string, Branch> {
  let map = branchesBySandbox.get(sandbox);
  if (!map) {
    map = new Map<string, Branch>();
    branchesBySandbox.set(sandbox, map);
  }
  return map;
}

export async function dryRunExperiment(
  sandbox: LocalSandbox,
  input: DryRunExperimentInput
): Promise<DryRunExperimentOutput> {
  const branchId = input.branchId ?? 'default';
  try {
    const branchMap = getBranchMap(sandbox);
    const currentRules = getInternalEnv(sandbox).getRules();
    const targetRules = input.candidateRules ?? currentRules;

    if (input.action === 'fork') {
      const branch = fork(sandbox.snapshot(), targetRules);
      branchMap.set(branchId, branch);
      return {
        ok: true,
        action: 'fork',
        branchId,
        status: 'forked',
        divergences: [],
        regressions: [],
      };
    }

    let branch = branchMap.get(branchId);
    if (!branch) {
      branch = fork(sandbox.snapshot(), targetRules);
      branchMap.set(branchId, branch);
    }

    if (input.action === 'apply') {
      const eventsToApply: SandboxEvent[] =
        input.events ??
        (input.mutationsJson ? (JSON.parse(input.mutationsJson) as SandboxEvent[]) : []);
      if (eventsToApply.length > 0) {
        apply(branch, eventsToApply);
      }
      const divergences = diff(branch, sandbox);
      return {
        ok: true,
        action: 'apply',
        branchId,
        status: 'applied',
        divergences,
        regressions: [],
      };
    }

    // Check regressions against recorded history or simulated traffic when candidateRules is provided
    const regressions: RuleRegression[] = [];
    if (input.candidateRules) {
      const ruleset = firestoreRules(input.candidateRules);
      const historyEvents = sandbox.history();
      for (const evt of historyEvents) {
        const rec = toOperationRecord(evt);
        if (!rec || rec.service !== 'firestore' || !rec.path) continue;
        if (rec.rules.kind === 'evaluated' && rec.rules.verdict === 'allow') {
          const methodMap: Record<string, FirestoreMethod> = {
            get: 'get',
            list: 'list',
            create: 'create',
            update: 'update',
            delete: 'delete',
            set: 'create',
            write: 'create',
          };
          const method = methodMap[rec.method] ?? 'get';
          const docPath = canonicalizePath(rec.path);
          const existingDoc = sandbox.admin.getDocument(docPath) as Record<string, unknown> | null;
          const testCase: FirestoreCase = {
            description: `Replay regression check for ${rec.method} ${docPath}`,
            expectation: 'ALLOW',
            method,
            path: docPath,
            auth: rec.auth?.uid ? { uid: rec.auth.uid, token: rec.auth.token } : null,
            resource: method === 'create' ? undefined : (existingDoc ?? undefined),
            data: method === 'delete' ? undefined : (existingDoc ?? { test: true }),
          };
          const explanation = ruleset.explain(testCase);
          if (explanation.decision === 'DENY') {
            regressions.push({
              path: docPath,
              operation: rec.method,
              authUid: rec.auth?.uid ?? null,
              previousDecision: 'ALLOW',
              candidateDecision: 'DENY',
              reason: explanation.notes.join('; ') || 'Denied by candidate rules',
            });
          }
        }
      }
    }

    const divergences = diff(branch, sandbox);

    if (input.action === 'diff') {
      return {
        ok: true,
        action: 'diff',
        branchId,
        status: 'diffed',
        divergences,
        regressions,
      };
    }

    if (input.action === 'promote') {
      if (regressions.length > 0 && !input.force) {
        return {
          ok: false,
          action: 'promote',
          branchId,
          status: 'rejected',
          divergences,
          regressions,
          error: `Promotion blocked by ${regressions.length} security rule regression(s). Pass force: true to override.`,
        };
      }
      promote(branch, sandbox);
      if (input.candidateRules) {
        setRules(sandbox, input.candidateRules);
      }
      branchMap.delete(branchId);
      return {
        ok: true,
        action: 'promote',
        branchId,
        status: 'promoted',
        divergences,
        regressions,
      };
    }

    if (input.action === 'discard') {
      discard(branch);
      branchMap.delete(branchId);
      return {
        ok: true,
        action: 'discard',
        branchId,
        status: 'discarded',
        divergences: [],
        regressions: [],
      };
    }

    return {
      ok: false,
      action: input.action,
      branchId,
      status: 'rejected',
      divergences: [],
      regressions: [],
      error: `Unsupported experiment action: ${input.action}`,
    };
  } catch (err) {
    return {
      ok: false,
      action: input.action,
      branchId,
      status: 'rejected',
      divergences: [],
      regressions: [],
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export interface DiagnoseRuleDenialInput {
  service: 'firestore' | 'database' | 'storage';
  operation: 'get' | 'list' | 'create' | 'update' | 'delete' | 'read' | 'write' | 'validate';
  path: string;
  resourceDataJson?: string;
  resourceData?: Record<string, unknown>;
  rulesSource?: string;
  auth?: {
    uid?: string;
    tenant?: string;
    claimsJson?: string;
    claims?: Record<string, unknown>;
  };
}

export interface DiagnoseRuleDenialOutput {
  ok: boolean;
  allowed: boolean;
  decision: 'ALLOW' | 'DENY' | 'UNSUPPORTED';
  trace: ExprTraceEntry[];
  decidingRule?: {
    line?: number;
    conditionText?: string;
  };
  notes: string[];
  error?: string;
}

export async function diagnoseRuleDenial(
  sandbox: LocalSandbox,
  input: DiagnoseRuleDenialInput
): Promise<DiagnoseRuleDenialOutput> {
  try {
    const cleanPath = canonicalizePath(input.path);
    const data =
      input.resourceData ??
      (input.resourceDataJson
        ? (JSON.parse(input.resourceDataJson) as Record<string, unknown>)
        : undefined);

    let authIdentity: { uid: string; token: Record<string, unknown> } | null = null;
    if (input.auth) {
      if (input.auth.uid) {
        const rawClaims =
          input.auth.claims ??
          (input.auth.claimsJson
            ? (JSON.parse(input.auth.claimsJson) as Record<string, unknown>)
            : {});
        const token = buildNormalizedClaims(rawClaims, input.auth.tenant);
        authIdentity = { uid: input.auth.uid, token };
      }
    } else {
      const lens = getActiveIdentityLens(sandbox);
      if (lens.mode === 'uid' && lens.uid) {
        const token = buildNormalizedClaims(lens.claims ?? {}, lens.tenant);
        authIdentity = { uid: lens.uid, token };
      }
    }

    if (input.service === 'firestore') {
      const rulesSource = input.rulesSource ?? getInternalEnv(sandbox).getRules();
      const ruleset = firestoreRules(rulesSource);
      const existingDoc = sandbox.admin.getDocument(cleanPath) as Record<string, unknown> | null;

      const methodMap: Record<string, FirestoreMethod> = {
        get: 'get',
        list: 'list',
        create: 'create',
        update: 'update',
        delete: 'delete',
        read: 'get',
        write: 'create',
      };
      const method = methodMap[input.operation] ?? 'get';

      const explanation = ruleset.explain({
        description: `Diagnose ${input.operation} on ${cleanPath}`,
        expectation: 'ALLOW',
        method,
        path: cleanPath,
        auth: authIdentity,
        resource: method === 'create' ? undefined : (existingDoc ?? undefined),
        data:
          method === 'delete'
            ? undefined
            : method === 'update' && existingDoc && data
            ? { ...existingDoc, ...data }
            : (data ?? existingDoc ?? undefined),
      });

      const exprTraces: ExprTraceEntry[] = [];
      for (const ruleEval of explanation.trace) {
        if (ruleEval.expressionTrace) {
          exprTraces.push(...ruleEval.expressionTrace);
        }
      }

      return {
        ok: true,
        allowed: explanation.decision === 'ALLOW',
        decision: explanation.decision,
        trace: exprTraces,
        decidingRule: explanation.deciding
          ? {
              line: explanation.deciding.line,
              conditionText: explanation.deciding.expression,
            }
          : undefined,
        notes: explanation.notes,
      };
    }

    if (input.service === 'database') {
      const rulesSource = input.rulesSource
        ? (JSON.parse(input.rulesSource) as Record<string, unknown>)
        : (getActiveRules(sandbox) as Record<string, unknown>);
      const ruleset = rtdbRules(rulesSource);
      const op = input.operation === 'write' || input.operation === 'create' || input.operation === 'update'
        ? 'write'
        : 'read';
      const rtdbCase: RtdbCase = {
        description: `Diagnose RTDB ${op} on /${cleanPath}`,
        expectation: 'ALLOW',
        operation: op,
        path: `/${cleanPath}`,
        auth: authIdentity,
        data: snapshotState(sandbox) as Record<string, unknown>,
        newData: data,
      };
      const explanation = ruleset.explain(rtdbCase);
      return {
        ok: true,
        allowed: explanation.decision === 'ALLOW',
        decision: explanation.decision,
        trace: [],
        notes: [explanation.reason],
      };
    }

    return {
      ok: false,
      allowed: false,
      decision: 'UNSUPPORTED',
      trace: [],
      notes: [`Service ${input.service} rule diagnosis is not supported yet.`],
    };
  } catch (err) {
    return {
      ok: false,
      allowed: false,
      decision: 'DENY',
      trace: [],
      notes: [],
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export interface VerifySecurityRulesInput {
  service: 'firestore' | 'database' | 'storage';
  action: 'lint' | 'resolve_modules' | 'simulate_suite' | 'check_conformance';
  source?: string;
  feature?: string;
  testCases?: Array<{
    expectation: 'ALLOW' | 'DENY';
    operation: 'get' | 'list' | 'create' | 'update' | 'delete' | 'read' | 'write' | 'validate';
    path: string;
    uid?: string;
    tenant?: string;
    claimsJson?: string;
    claims?: Record<string, unknown>;
    resourceDataJson?: string;
  }>;
}

export interface VerifySecurityRulesOutput {
  ok: boolean;
  action: VerifySecurityRulesInput['action'];
  passed?: number;
  failed?: number;
  issues?: RuleIssue[];
  supported?: boolean;
  error?: string;
}

export async function verifySecurityRules(
  sandbox: LocalSandbox,
  input: VerifySecurityRulesInput
): Promise<VerifySecurityRulesOutput> {
  try {
    if (input.action === 'lint') {
      const source = input.source ?? getInternalEnv(sandbox).getRules();
      const issues = lintRules(source);
      return {
        ok: true,
        action: 'lint',
        issues,
      };
    }

    if (input.action === 'resolve_modules') {
      return {
        ok: true,
        action: 'resolve_modules',
        issues: [],
      };
    }

    if (input.action === 'check_conformance') {
      return {
        ok: true,
        action: 'check_conformance',
        supported: true,
      };
    }

    if (input.action === 'simulate_suite') {
      const source = input.source ?? getInternalEnv(sandbox).getRules();
      const ruleset = firestoreRules(source);
      const cases: FirestoreCase[] = (input.testCases ?? []).map((tc, idx) => {
        const rawClaims =
          tc.claims ??
          (tc.claimsJson ? (JSON.parse(tc.claimsJson) as Record<string, unknown>) : {});
        const token = buildNormalizedClaims(rawClaims, tc.tenant);
        return {
          description: `Case #${idx + 1}: ${tc.operation} ${tc.path}`,
          expectation: tc.expectation,
          method: (tc.operation === 'read' ? 'get' : tc.operation === 'write' ? 'create' : tc.operation) as FirestoreMethod,
          path: canonicalizePath(tc.path),
          auth: tc.uid ? { uid: tc.uid, token } : null,
          data: tc.resourceDataJson ? (JSON.parse(tc.resourceDataJson) as Record<string, unknown>) : undefined,
        };
      });
      const summary = ruleset.simulate(cases);
      return {
        ok: summary.failed === 0,
        action: 'simulate_suite',
        passed: summary.passed,
        failed: summary.failed,
      };
    }

    return {
      ok: false,
      action: input.action,
      error: `Unsupported verifySecurityRules action: ${input.action}`,
    };
  } catch (err) {
    return {
      ok: false,
      action: input.action,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

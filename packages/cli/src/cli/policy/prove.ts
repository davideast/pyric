/**
 * `pyric policy prove <file|->`: static verification, placement & cost split,
 * temp `.mjs` standalone ESM import check, scenario replay, and deterministic
 * seeded differential fuzzing with structured counterexamples & traces.
 */
import type { ParsedArgs } from '../parse-args.js';
import {
  analyzePolicySource,
  collectCompleteModeDiagnostics,
  writeReport,
} from './check.js';
import { makeSimpleDiagnostic } from './diagnostics.js';
import { formatProveText } from './format.js';
import { isPlainRecord, loadPolicyInputs } from './input.js';
import { loadPolicyExperimentalApi, verifyStandaloneModuleEsm } from './loader.js';
import {
  POLICY_EXIT_OK,
  POLICY_EXIT_PLACEMENT,
  POLICY_EXIT_PROOF,
  POLICY_EXIT_STATIC,
  POLICY_EXIT_USAGE,
  type PolicyCliDeps,
  type PolicyCliDiagnostic,
  type PolicyCounterexample,
  type PolicyExitCode,
  type PolicyFailureTrace,
  type PolicyProveReport,
  type PolicyProveScenarioItem,
  type ProvePolicyScenario,
  type StandaloneSummary,
} from './types.js';

function extractFailureTrace(interpreterOutcome: unknown): {
  requirement?: string;
  reason?: string;
  trace?: PolicyFailureTrace;
} {
  if (!isPlainRecord(interpreterOutcome) || interpreterOutcome.ok !== false) {
    return {};
  }
  const requirement =
    typeof interpreterOutcome.requirement === 'string'
      ? interpreterOutcome.requirement
      : undefined;
  const reason =
    typeof interpreterOutcome.reason === 'string'
      ? interpreterOutcome.reason
      : undefined;
  const rawTrace = interpreterOutcome.trace;
  const trace =
    isPlainRecord(rawTrace) &&
    typeof rawTrace.requirement === 'string' &&
    isPlainRecord(rawTrace.span) &&
    Array.isArray(rawTrace.bindings)
      ? (rawTrace as unknown as PolicyFailureTrace)
      : undefined;
  return { requirement, reason, trace };
}

function scenarioInputPayload(scenario: ProvePolicyScenario | undefined): unknown {
  if (!scenario) return undefined;
  if (scenario.transition !== undefined) return scenario.transition;
  return {
    ...(scenario.functionName !== undefined ? { functionName: scenario.functionName } : {}),
    args: scenario.args ?? [],
  };
}

export async function runPolicyProve(
  parsed: ParsedArgs,
  deps: PolicyCliDeps = {},
): Promise<number> {
  const inputs = await loadPolicyInputs('prove', parsed, deps);
  const api = await (deps.loadPolicyApi ?? loadPolicyExperimentalApi)();
  const effectiveLimit = inputs.expressionLimit ?? 8192;

  const analysis = analyzePolicySource(api, inputs.source, {
    kind: inputs.kind,
    expressionLimit: effectiveLimit,
    firestoreBindings: inputs.firestoreBindings,
    storageBindings: inputs.storageBindings,
    rtdbBindings: inputs.rtdbBindings,
  });

  if (!analysis.staticCheck.ok) {
    const report: PolicyProveReport = {
      schema: 'pyric.policy.prove.v1',
      command: 'prove',
      ok: false,
      exitCode: POLICY_EXIT_STATIC,
      file: inputs.file,
      kind: analysis.kind,
      mode: inputs.mode,
      staticCheck: analysis.staticCheck,
      diagnostics: analysis.diagnostics,
      standalone: { ...analysis.standalone, esmVerified: false },
      placement: analysis.placement,
      cost: analysis.cost,
      scenarios: { total: 0, passed: 0, failed: 0, results: [] },
      fuzz: {
        enabled: inputs.fuzz.enabled,
        seed: inputs.fuzz.seed,
        casesRequested: inputs.fuzz.cases,
        casesRun: 0,
        passed: 0,
        failed: 0,
        divergences: [],
      },
      counterexamples: [],
    };
    writeReport(inputs.json, report, formatProveText(report), deps);
    return POLICY_EXIT_STATIC;
  }

  const hasTransitionTarget =
    inputs.firestoreBindings !== undefined ||
    inputs.storageBindings !== undefined ||
    inputs.rtdbBindings !== undefined;

  if (analysis.kind === 'transition' && inputs.mode === 'complete' && !hasTransitionTarget) {
    const diag = makeSimpleDiagnostic(
      'USAGE_ERROR',
      'cli',
      '--mode complete requires at least one of --firestore-bindings, --storage-bindings, or --rtdb-bindings for transition policies',
    );
    const report: PolicyProveReport = {
      schema: 'pyric.policy.prove.v1',
      command: 'prove',
      ok: false,
      exitCode: POLICY_EXIT_USAGE,
      file: inputs.file,
      kind: analysis.kind,
      mode: inputs.mode,
      staticCheck: analysis.staticCheck,
      diagnostics: [diag],
      standalone: { ...analysis.standalone, esmVerified: false },
      placement: analysis.placement,
      cost: analysis.cost,
      scenarios: { total: 0, passed: 0, failed: 0, results: [] },
      fuzz: {
        enabled: inputs.fuzz.enabled,
        seed: inputs.fuzz.seed,
        casesRequested: inputs.fuzz.cases,
        casesRun: 0,
        passed: 0,
        failed: 0,
        divergences: [],
      },
      counterexamples: [],
    };
    if (inputs.json) {
      writeReport(true, report, '', deps);
    } else {
      (deps.stderr ?? process.stderr).write(`pyric policy prove: ${diag.message}\n`);
    }
    return POLICY_EXIT_USAGE;
  }

  const diagnostics: PolicyCliDiagnostic[] = [...analysis.diagnostics];
  let esmVerified = false;
  let standaloneError = analysis.standalone.error;

  if (analysis.standalone.ok && analysis.standaloneSource !== undefined && inputs.verifyEsm) {
    const verifyFn = deps.verifyStandaloneEsm ?? verifyStandaloneModuleEsm;
    try {
      await verifyFn(analysis.standaloneSource, analysis.standalone.exports);
      esmVerified = true;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      standaloneError = message;
      diagnostics.push(
        makeSimpleDiagnostic('STANDALONE_EMIT_ERROR', 'standalone', message, {
          target: 'standalone',
        }),
      );
    }
  }

  const rawProof = api.provePolicy(inputs.source, {
    kind: analysis.kind,
    expressionLimit: effectiveLimit,
    ...(inputs.firestoreBindings !== undefined ? { firestore: inputs.firestoreBindings } : {}),
    ...(inputs.rtdbBindings !== undefined ? { rtdb: inputs.rtdbBindings } : {}),
    scenarios: inputs.scenarios,
    fuzz: inputs.fuzz,
  });

  if (!rawProof.standalone.ok && analysis.standalone.ok) {
    standaloneError = rawProof.standalone.error ?? 'Standalone instantiation failed during proof';
    diagnostics.push(
      makeSimpleDiagnostic('STANDALONE_EMIT_ERROR', 'standalone', standaloneError, {
        target: 'standalone',
      }),
    );
  }

  const standalone: StandaloneSummary = {
    ok: analysis.standalone.ok && rawProof.standalone.ok && (!inputs.verifyEsm || esmVerified),
    exports: analysis.standalone.exports,
    moduleBytes: analysis.standalone.moduleBytes,
    esmVerified,
    ...(standaloneError !== undefined ? { error: standaloneError } : {}),
  };

  let completePlacementFailed = false;
  if (inputs.mode === 'complete') {
    const residualDiags = collectCompleteModeDiagnostics(analysis.kind, analysis.placement);
    if (residualDiags.length > 0) {
      completePlacementFailed = true;
      diagnostics.push(...residualDiags);
    }
  }

  const counterexamples: PolicyCounterexample[] = [];
  const scenarioResults: PolicyProveScenarioItem[] = rawProof.scenarios.results.map((res, idx) => {
    const extracted = extractFailureTrace(res.interpreter);
    const item: PolicyProveScenarioItem = {
      name: res.name,
      ok: res.ok,
      parityOk: res.parityOk,
      interpreter: res.interpreter,
      standalone: res.standalone,
      ...(res.firestore !== undefined ? { firestore: res.firestore } : {}),
      ...(res.rtdb !== undefined ? { rtdb: res.rtdb } : {}),
      ...(res.mismatch !== undefined ? { mismatch: res.mismatch } : {}),
      ...(extracted.trace !== undefined ? { failureTrace: extracted.trace } : {}),
    };

    if (!res.ok) {
      const mismatch = res.mismatch ?? 'Scenario failed';
      counterexamples.push({
        source: 'scenario',
        name: res.name,
        mismatch,
        input: scenarioInputPayload(inputs.scenarios[idx]),
        ...(extracted.requirement !== undefined ? { requirement: extracted.requirement } : {}),
        ...(extracted.trace?.span !== undefined ? { span: extracted.trace.span } : {}),
        ...(extracted.reason !== undefined ? { reason: extracted.reason } : {}),
        ...(extracted.trace !== undefined ? { trace: extracted.trace } : {}),
        interpreter: res.interpreter,
        standalone: res.standalone,
        ...(res.firestore !== undefined ? { firestore: res.firestore } : {}),
        ...(res.rtdb !== undefined ? { rtdb: res.rtdb } : {}),
      });
      diagnostics.push(
        makeSimpleDiagnostic(
          res.parityOk ? 'SCENARIO_FAILURE' : 'PARITY_DIVERGENCE',
          'scenario',
          `scenario '${res.name}': ${mismatch}${extracted.reason ? ` (${extracted.reason})` : ''}`,
          {
            span: extracted.trace?.span ?? null,
            requirement: extracted.requirement,
            scenario: res.name,
          },
        ),
      );
    }
    return item;
  });

  for (const div of rawProof.fuzz.divergences) {
    counterexamples.push({
      source: 'fuzz',
      caseIndex: div.caseIndex,
      mismatch: 'Cross-engine differential fuzz divergence',
      input: div.input,
      interpreter: div.interpreter,
      standalone: div.standalone,
      ...(div.firestore !== undefined ? { firestore: div.firestore } : {}),
      ...(div.rtdb !== undefined ? { rtdb: div.rtdb } : {}),
    });
    diagnostics.push(
      makeSimpleDiagnostic(
        'PARITY_DIVERGENCE',
        'fuzz',
        `fuzz case #${div.caseIndex} diverged across engines`,
      ),
    );
  }

  const fuzzFailed = rawProof.fuzz.casesRun - rawProof.fuzz.passed;
  const hasProofFailure =
    rawProof.scenarios.failed > 0 || rawProof.fuzz.divergences.length > 0 || fuzzFailed > 0;

  let exitCode: PolicyExitCode = POLICY_EXIT_OK;
  if (hasProofFailure) {
    exitCode = POLICY_EXIT_PROOF;
  } else if (!standalone.ok || completePlacementFailed) {
    exitCode = POLICY_EXIT_PLACEMENT;
  }

  const report: PolicyProveReport = {
    schema: 'pyric.policy.prove.v1',
    command: 'prove',
    ok: exitCode === POLICY_EXIT_OK,
    exitCode,
    file: inputs.file,
    kind: analysis.kind,
    mode: inputs.mode,
    staticCheck: analysis.staticCheck,
    diagnostics,
    standalone,
    placement: analysis.placement,
    cost: analysis.cost,
    scenarios: {
      total: rawProof.scenarios.total,
      passed: rawProof.scenarios.passed,
      failed: rawProof.scenarios.failed,
      results: scenarioResults,
    },
    fuzz: {
      enabled: rawProof.fuzz.enabled,
      seed: rawProof.fuzz.seed,
      casesRequested: inputs.fuzz.cases,
      casesRun: rawProof.fuzz.casesRun,
      passed: rawProof.fuzz.passed,
      failed: fuzzFailed,
      divergences: rawProof.fuzz.divergences,
    },
    counterexamples,
  };

  writeReport(inputs.json, report, formatProveText(report), deps);
  return exitCode;
}

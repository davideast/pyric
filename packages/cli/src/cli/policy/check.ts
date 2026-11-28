/**
 * `pyric policy check <file|->` and shared static/placement analysis helper
 * reused by `prove` and `emit`.
 */
import type { ParsedArgs } from '../parse-args.js';
import {
  buildCostSummary,
  buildFirestorePlacementReport,
  buildRtdbPlacementReport,
  buildStoragePlacementReport,
  emptyCostSummary,
  estimateGenericIrUnits,
  functionCostItems,
  makeCompilerDiagnostic,
  makeSimpleDiagnostic,
  spanFromLocation,
} from './diagnostics.js';
import { formatCheckText, formatJson } from './format.js';
import { loadPolicyInputs, type LoadedPolicyInputs } from './input.js';
import { loadPolicyExperimentalApi } from './loader.js';
import {
  POLICY_EXIT_OK,
  POLICY_EXIT_PLACEMENT,
  POLICY_EXIT_STATIC,
  POLICY_EXIT_USAGE,
  type BoundedOpCostDetail,
  type ExpressionCostBreakdown,
  type FunctionPlacementItem,
  type PolicyCheckReport,
  type PolicyCliDeps,
  type PolicyCliDiagnostic,
  type PolicyCostItem,
  type PolicyCostSummary,
  type PolicyExitCode,
  type PolicyExperimentalApi,
  type PolicyPlacementSummary,
  type PolicyProgramKind,
  type RawCheckedPolicyIR,
  type RawCompiledFunction,
  type RawCompiledPolicy,
  type StandaloneSummary,
  type StaticCheckSummary,
  type TargetPlacementReport,
} from './types.js';

export interface PolicyAnalysisResult {
  readonly ok: boolean;
  readonly kind: PolicyProgramKind;
  readonly staticCheck: StaticCheckSummary;
  readonly diagnostics: PolicyCliDiagnostic[];
  readonly placement: PolicyPlacementSummary;
  readonly cost: PolicyCostSummary;
  readonly standalone: StandaloneSummary;
  readonly standaloneSource?: string;
  readonly checked?: RawCheckedPolicyIR;
  readonly compiledPolicy?: RawCompiledPolicy;
  readonly compiledFunction?: RawCompiledFunction;
}

export function emptyStaticCheck(expressionLimit: number): StaticCheckSummary {
  return {
    ok: false,
    extensions: [],
    functions: [],
    topoOrder: [],
    exports: [],
    requirements: [],
    transitionName: null,
    hasDerive: false,
    acyclic: false,
    expressionLimit,
  };
}

export function analyzePolicySource(
  api: PolicyExperimentalApi,
  source: string,
  options: {
    kind?: PolicyProgramKind;
    expressionLimit?: number;
    firestoreBindings?: LoadedPolicyInputs['firestoreBindings'];
    storageBindings?: LoadedPolicyInputs['storageBindings'];
    rtdbBindings?: LoadedPolicyInputs['rtdbBindings'];
  },
): PolicyAnalysisResult {
  const kind = options.kind ?? api.detectPolicyKind(source);
  const fallbackLimit = options.expressionLimit ?? (kind === 'module' ? 1000000 : 8192);

  let ir: unknown;
  try {
    ir = api.parsePolicyIR(source, kind);
  } catch (err) {
    return {
      ok: false,
      kind,
      staticCheck: emptyStaticCheck(fallbackLimit),
      diagnostics: [makeCompilerDiagnostic(err, source, 'parse')],
      placement: {},
      cost: emptyCostSummary(fallbackLimit),
      standalone: {
        ok: false,
        exports: [],
        moduleBytes: 0,
        error: 'Skipped due to parse failure',
      },
    };
  }

  let checked: RawCheckedPolicyIR;
  try {
    checked = api.checkPolicyIR(
      ir,
      options.expressionLimit !== undefined ? { expressionLimit: options.expressionLimit } : {},
    );
  } catch (err) {
    return {
      ok: false,
      kind,
      staticCheck: emptyStaticCheck(fallbackLimit),
      diagnostics: [makeCompilerDiagnostic(err, source, 'static-check')],
      placement: {},
      cost: emptyCostSummary(fallbackLimit),
      standalone: {
        ok: false,
        exports: [],
        moduleBytes: 0,
        error: 'Skipped due to static check failure',
      },
    };
  }

  const staticCheck: StaticCheckSummary = {
    ok: true,
    extensions: [...checked.extensions],
    functions: [...checked.functions.keys()],
    topoOrder: [...checked.topoOrder],
    exports: [...checked.exports],
    requirements: [...checked.requirementNames],
    transitionName: checked.program.transition?.name ?? null,
    hasDerive: Boolean(checked.program.transition?.derivation),
    acyclic: true,
    expressionLimit: checked.expressionLimit,
  };

  const diagnostics: PolicyCliDiagnostic[] = [];
  let standaloneSource: string | undefined;
  let standalone: StandaloneSummary;
  try {
    const emitted = api.emitStandaloneModule(checked);
    standaloneSource = emitted.moduleSource;
    standalone = {
      ok: true,
      exports: [...emitted.exports],
      moduleBytes: Buffer.byteLength(emitted.moduleSource, 'utf8'),
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    standalone = { ok: false, exports: [], moduleBytes: 0, error: message };
    diagnostics.push(
      makeSimpleDiagnostic('STANDALONE_EMIT_ERROR', 'standalone', message, {
        target: 'standalone',
      }),
    );
  }

  const placement: PolicyPlacementSummary = {};
  let costItems: PolicyCostItem[] = [];
  let compiledPolicy: RawCompiledPolicy | undefined;
  let compiledFunction: RawCompiledFunction | undefined;

  if (kind === 'transition') {
    compiledPolicy = api.compilePolicy(source, { expressionLimit: checked.expressionLimit });
    const rawFsBaseline = compiledPolicy.firestore(options.firestoreBindings ?? {}, 'mixed');
    const baselineCosts = new Map<string, ExpressionCostBreakdown>();
    costItems = rawFsBaseline.map((row) => {
      baselineCosts.set(row.requirement, row.cost);
      return {
        name: row.requirement,
        kind: 'requirement' as const,
        span: spanFromLocation(row.location, source),
        cost: {
          sourceUnits: row.cost.sourceUnits,
          sourceLimit: row.cost.sourceLimit,
          targetUnits: options.firestoreBindings ? row.cost.targetUnits : null,
          targetLimit: options.firestoreBindings ? row.cost.targetLimit : null,
          withinSourceBudget: row.cost.withinSourceBudget,
          withinTargetBudget: options.firestoreBindings ? row.cost.withinTargetBudget : null,
          letUnits: row.cost.letUnits,
          conditionUnits: row.cost.conditionUnits,
          boundedOps: row.cost.boundedOps.map((b) => ({ ...b })),
        },
      };
    });

    if (options.firestoreBindings !== undefined) {
      placement.firestore = buildFirestorePlacementReport(rawFsBaseline, source);
    }
    if (options.storageBindings !== undefined) {
      const rawStorage = compiledPolicy.storage(options.storageBindings, 'mixed');
      placement.storage = buildStoragePlacementReport(
        rawStorage,
        baselineCosts,
        checked.expressionLimit,
        source,
      );
    }
    if (options.rtdbBindings !== undefined) {
      const rawRtdb = compiledPolicy.rtdb(options.rtdbBindings, 'mixed');
      placement.rtdb = buildRtdbPlacementReport(rawRtdb, source);
    }
  } else if (kind === 'function') {
    compiledFunction = api.compileFunction(source, { expressionLimit: checked.expressionLimit });
    const fnPlacement = compiledFunction.placement();
    const rawFn = checked.functions.values().next().value?.fn;
    const item: FunctionPlacementItem = {
      name: fnPlacement.name,
      exported: true,
      parameters: rawFn ? [...rawFn.parameters] : [],
      span: rawFn?.loc ? spanFromLocation(`${rawFn.loc.line}:${rawFn.loc.col}`, source) : null,
      cost: {
        ...fnPlacement.cost,
        boundedOps: fnPlacement.cost.boundedOps.map((b) => ({ ...b })),
      },
      firestoreLowerable: fnPlacement.firestoreLowerable,
      firestoreReason: fnPlacement.reason,
      firestoreDiagnostics: fnPlacement.diagnostics.map((d) => ({ ...d })),
    };
    if (options.rtdbBindings !== undefined) {
      try {
        compiledFunction.rtdbPredicate(options.rtdbBindings);
        item.rtdbLowerable = true;
        item.rtdbReason = 'Lowerable to RTDB validation predicate';
      } catch (err) {
        item.rtdbLowerable = false;
        item.rtdbReason = err instanceof Error ? err.message : String(err);
      }
    }
    placement.functions = [item];
    costItems = functionCostItems(placement.functions);
  } else {
    const fnItems: FunctionPlacementItem[] = [];
    for (const { fn } of checked.functions.values()) {
      const boundedOps: BoundedOpCostDetail[] = [];
      const letUnits = fn.lets.reduce(
        (sum, binding) => sum + 1 + estimateGenericIrUnits(binding.value, boundedOps),
        0,
      );
      const conditionUnits = estimateGenericIrUnits(fn.body, boundedOps);
      const sourceUnits = letUnits + conditionUnits;
      fnItems.push({
        name: fn.name,
        exported: fn.exported,
        parameters: [...fn.parameters],
        span: fn.loc ? spanFromLocation(`${fn.loc.line}:${fn.loc.col}`, source) : null,
        cost: {
          sourceUnits,
          sourceLimit: checked.expressionLimit,
          targetUnits: null,
          targetLimit: null,
          withinSourceBudget: sourceUnits <= checked.expressionLimit,
          withinTargetBudget: null,
          letUnits,
          conditionUnits,
          boundedOps,
        },
      });
    }
    placement.functions = fnItems;
    costItems = functionCostItems(fnItems);
  }

  const cost = buildCostSummary(checked.expressionLimit, costItems, placement);
  return {
    ok: diagnostics.length === 0,
    kind,
    staticCheck,
    diagnostics,
    placement,
    cost,
    standalone,
    standaloneSource,
    checked,
    compiledPolicy,
    compiledFunction,
  };
}

export function collectCompleteModeDiagnostics(
  kind: PolicyProgramKind,
  placement: PolicyPlacementSummary,
): PolicyCliDiagnostic[] {
  const out: PolicyCliDiagnostic[] = [];
  if (kind === 'transition') {
    const targets: TargetPlacementReport[] = [
      placement.firestore,
      placement.storage,
      placement.rtdb,
    ].filter((t): t is TargetPlacementReport => t !== undefined);
    for (const report of targets) {
      for (const row of report.rows) {
        if (row.lowered) continue;
        const detail = row.completeReason ?? row.reason;
        out.push(
          makeSimpleDiagnostic(
            'TARGET_LOWERING_ERROR',
            'placement',
            `${report.target} residual requirement '${row.requirement}': ${detail}`,
            {
              span: row.span,
              target: report.target,
              requirement: row.requirement,
            },
          ),
        );
      }
    }
  } else if (kind === 'function') {
    const fn = placement.functions?.[0];
    if (fn && fn.firestoreLowerable === false) {
      out.push(
        makeSimpleDiagnostic(
          'TARGET_LOWERING_ERROR',
          'placement',
          `function '${fn.name}' is not Firestore-lowerable: ${fn.firestoreReason ?? 'unsupported'}`,
          { span: fn.span, target: 'firestore' },
        ),
      );
    }
    if (fn && fn.rtdbLowerable === false) {
      out.push(
        makeSimpleDiagnostic(
          'TARGET_LOWERING_ERROR',
          'placement',
          `function '${fn.name}' is not RTDB-lowerable: ${fn.rtdbReason ?? 'unsupported'}`,
          { span: fn.span, target: 'rtdb' },
        ),
      );
    }
  } else {
    out.push(
      makeSimpleDiagnostic(
        'TARGET_LOWERING_ERROR',
        'placement',
        'module policies target standalone execution only and cannot satisfy --mode complete',
        { target: 'standalone' },
      ),
    );
  }
  return out;
}

export function writeReport(
  json: boolean,
  payload: unknown,
  text: string,
  deps: PolicyCliDeps,
): void {
  const out = deps.stdout ?? process.stdout;
  out.write(json ? formatJson(payload) : text);
}

export async function runPolicyCheck(
  parsed: ParsedArgs,
  deps: PolicyCliDeps = {},
): Promise<number> {
  const inputs = await loadPolicyInputs('check', parsed, deps);
  const api = await (deps.loadPolicyApi ?? loadPolicyExperimentalApi)();
  const analysis = analyzePolicySource(api, inputs.source, {
    kind: inputs.kind,
    expressionLimit: inputs.expressionLimit,
    firestoreBindings: inputs.firestoreBindings,
    storageBindings: inputs.storageBindings,
    rtdbBindings: inputs.rtdbBindings,
  });

  const hasTransitionTarget =
    inputs.firestoreBindings !== undefined ||
    inputs.storageBindings !== undefined ||
    inputs.rtdbBindings !== undefined;

  if (analysis.staticCheck.ok && analysis.kind === 'transition' && inputs.mode === 'complete' && !hasTransitionTarget) {
    const diag = makeSimpleDiagnostic(
      'USAGE_ERROR',
      'cli',
      '--mode complete requires at least one of --firestore-bindings, --storage-bindings, or --rtdb-bindings for transition policies',
    );
    const report: PolicyCheckReport = {
      schema: 'pyric.policy.check.v1',
      command: 'check',
      ok: false,
      exitCode: POLICY_EXIT_USAGE,
      file: inputs.file,
      kind: analysis.kind,
      mode: inputs.mode,
      staticCheck: analysis.staticCheck,
      diagnostics: [diag],
      placement: analysis.placement,
      cost: analysis.cost,
      standalone: analysis.standalone,
    };
    if (inputs.json) {
      writeReport(true, report, '', deps);
    } else {
      (deps.stderr ?? process.stderr).write(`pyric policy check: ${diag.message}\n`);
    }
    return POLICY_EXIT_USAGE;
  }

  const diagnostics = [...analysis.diagnostics];
  if (analysis.staticCheck.ok && inputs.mode === 'complete') {
    diagnostics.push(...collectCompleteModeDiagnostics(analysis.kind, analysis.placement));
  }

  let exitCode: PolicyExitCode = POLICY_EXIT_OK;
  if (!analysis.staticCheck.ok) {
    exitCode = POLICY_EXIT_STATIC;
  } else if (diagnostics.some((d) => d.severity === 'error')) {
    exitCode = POLICY_EXIT_PLACEMENT;
  }

  const report: PolicyCheckReport = {
    schema: 'pyric.policy.check.v1',
    command: 'check',
    ok: exitCode === POLICY_EXIT_OK,
    exitCode,
    file: inputs.file,
    kind: analysis.kind,
    mode: inputs.mode,
    staticCheck: analysis.staticCheck,
    diagnostics,
    placement: analysis.placement,
    cost: analysis.cost,
    standalone: analysis.standalone,
  };

  writeReport(inputs.json, report, formatCheckText(report), deps);
  return exitCode;
}

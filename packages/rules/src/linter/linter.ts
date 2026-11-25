/**
 * Firestore Security Rules Linter.
 *
 * Analyzes rules source or AST for structural issues that cause
 * compilation failures (400) or runtime expression budget exhaustion (403).
 */
import type { AllowRule, FirestoreRules, FunctionDef } from '../grammar/FirestoreAST.js';
import { parseToASTOrError, type ParseError } from '../grammar/FirestoreParser.js';
import {
  compileLimitViolations,
  type CompileLimitViolation,
} from '../grammar/compile-limits.js';
import { countDocumentAccessCalls } from '../grammar/document-access-count.js';
import { collectRulesetScopes } from '../grammar/function-scopes.js';
import {
  allServiceBlocks,
  isStorageServiceName,
  selectServicesToAnalyze,
  topLevelMatches,
  withSingleService,
} from '../grammar/service-blocks.js';
import {
  isLocalRelativeModuleSpecifier,
  resolveBundledModulesForAnalysis,
  resolveBundledModulesWithDiagnostics,
} from '../modules/resolver-browser.js';
import type { TestCase } from '../test/spec.js';
import {
  collectDeclaredFunctions,
  collectServiceRules,
  deepestChain,
} from './ast-utils.js';
import {
  checkCallDepth,
  checkExpressionBudget,
  checkGetCount,
  checkGetDuplication,
  checkLibraryCalls,
  checkMemberChainLength,
  checkSharedGates,
} from './budget-warnings.js';
import {
  UNRESOLVED_MODULES_LINT_MESSAGE,
  checkAdditionalCompileRejections,
  checkGlobMatchCount,
  checkLetBindings,
  checkNestingDepth,
  checkSlashStartsPath,
  checkSourceSize,
  pushWarning,
} from './compile-limit-warnings.js';
import { estimateExpressionCosts } from './expression-cost.js';
import { checkHallucinations, checkSyntaxHints } from './hallucinations.js';
import {
  checkPermissiveRules,
  checkRecursiveWildcardOpen,
  checkRequestTimePinned,
  checkRulesWeakened,
  collectRootAwarePolicyTargets,
} from './policy-warnings.js';
import { checkServiceDeclarations } from './service-declarations.js';

// === Types ===

export interface LintWarning {
  rule: string;
  /** `info` findings report, and never block a write or a deploy. */
  severity: 'info' | 'warning' | 'error';
  message: string;
  location?: {
    functionName?: string;
    ruleIndex?: number;
    matchPath?: string;
    line?: number;
    testCaseDescription?: string;
  };
  fix?: string;
}

export interface RulesMetrics {
  sourceSize: number;
  functionCount: number;
  allowRuleCount: number;
  maxChainDepth: number;
  maxChainOp: string;
  maxLetBindings: number;
  maxLetBindingsFunction: string;
  maxCallDepth: number;
  maxEstimatedExpressions: number;
  getCallCount: number;
}

export interface LintResult {
  warnings: LintWarning[];
  metrics: RulesMetrics;
  parseError?: ParseError;
}

export interface LintOptions {
  testCases?: TestCase[];
  previousSource?: string;
  allowDebug?: boolean;
  targetService?: 'cloud.firestore' | 'firebase.storage' | 'all';
}

/**
 * Lint Firestore or Storage security rules.
 */
export function lintFirestoreRules(source: string, options: LintOptions = {}): LintResult {
  const warnings: LintWarning[] = [];

  warnings.push(...checkSyntaxHints(source));
  checkSourceSize(source, warnings);

  const parsed = parseToASTOrError(source);
  if (!parsed.ok) {
    return { warnings, metrics: sourceOnlyMetrics(source), parseError: parsed.error };
  }
  warnings.push(...checkServiceDeclarations(parsed.ast, options.targetService));
  const servicesToAnalyze = selectServicesToAnalyze(parsed.ast, options.targetService);
  if (servicesToAnalyze.length === 0) {
    if (parsed.ast.version === '2+modules') {
      const firstRelative = parsed.ast.imports.find((imp) =>
        isLocalRelativeModuleSpecifier(imp.module),
      );
      if (firstRelative !== undefined) {
        pushWarning(
          warnings,
          {
            rule: 'UNRESOLVED_MODULES',
            severity: 'warning',
            message: UNRESOLVED_MODULES_LINT_MESSAGE,
            fix: 'Resolve module imports with `pyric rules resolve` or `resolveModules` before compiling.',
          },
          { line: firstRelative.loc?.line ?? parsed.ast.loc?.line ?? 1 },
        );
      }
    }
    return { warnings, metrics: sourceOnlyMetrics(source) };
  }
  try {
    const emittedResolutionKeys = new Set<string>();
    const combinedMetrics: RulesMetrics = sourceOnlyMetrics(source);
    for (let serviceIndex = 0; serviceIndex < servicesToAnalyze.length; serviceIndex++) {
      const service = servicesToAnalyze[serviceIndex];
      if (service === undefined) continue;
      let svcTarget: 'cloud.firestore' | 'firebase.storage' = 'cloud.firestore';
      if (isStorageServiceName(service.name)) {
        svcTarget = 'firebase.storage';
      }
      const { ast: astForAnalysis, resolutionError } = resolveBundledModulesWithDiagnostics(
        withSingleService(parsed.ast, service),
        source,
        { targetService: svcTarget },
      );
      if (resolutionError !== undefined) {
        const key = `${resolutionError.code}:${resolutionError.line}:${resolutionError.message}`;
        if (!emittedResolutionKeys.has(key)) {
          emittedResolutionKeys.add(key);
          pushWarning(
            warnings,
            {
              rule: resolutionError.code,
              severity: 'error',
              message: resolutionError.message,
            },
            { line: resolutionError.line },
          );
        }
      }
      const svcResult = analyzeParsedRules(
        astForAnalysis,
        source,
        options,
        warnings,
        serviceIndex > 0,
        svcTarget,
        resolutionError !== undefined,
      );
      let globalFnCount = 0;
      if (serviceIndex > 0) {
        globalFnCount = astForAnalysis.functions?.length ?? 0;
      }
      combinedMetrics.functionCount += Math.max(0, svcResult.metrics.functionCount - globalFnCount);
      combinedMetrics.allowRuleCount += svcResult.metrics.allowRuleCount;
      if (svcResult.metrics.maxChainDepth > combinedMetrics.maxChainDepth) {
        combinedMetrics.maxChainDepth = svcResult.metrics.maxChainDepth;
        combinedMetrics.maxChainOp = svcResult.metrics.maxChainOp;
      }
      if (svcResult.metrics.maxLetBindings > combinedMetrics.maxLetBindings) {
        combinedMetrics.maxLetBindings = svcResult.metrics.maxLetBindings;
        combinedMetrics.maxLetBindingsFunction = svcResult.metrics.maxLetBindingsFunction;
      }
      if (svcResult.metrics.maxCallDepth > combinedMetrics.maxCallDepth) {
        combinedMetrics.maxCallDepth = svcResult.metrics.maxCallDepth;
      }
      if (svcResult.metrics.maxEstimatedExpressions > combinedMetrics.maxEstimatedExpressions) {
        combinedMetrics.maxEstimatedExpressions = svcResult.metrics.maxEstimatedExpressions;
      }
      if (svcResult.metrics.getCallCount > combinedMetrics.getCallCount) {
        combinedMetrics.getCallCount = svcResult.metrics.getCallCount;
      }
    }
    return { warnings, metrics: combinedMetrics };
  } catch (error) {
    if (!(error instanceof RangeError)) throw error;
    warnings.push(expressionTooDeepWarning());
    return { warnings, metrics: sourceOnlyMetrics(source) };
  }
}

function sourceOnlyMetrics(source: string): RulesMetrics {
  return {
    sourceSize: source.length,
    functionCount: 0,
    allowRuleCount: 0,
    maxChainDepth: 0,
    maxChainOp: '',
    maxLetBindings: 0,
    maxLetBindingsFunction: '',
    maxCallDepth: 0,
    maxEstimatedExpressions: 0,
    getCallCount: 0,
  };
}

function expressionTooDeepWarning(): LintWarning {
  return {
    rule: 'EXPRESSION_TOO_DEEP',
    severity: 'error',
    message:
      'An expression chains or nests more terms, counting the bodies of the functions it calls, than the linter can analyze, ' +
      "so the remaining checks did not run. This is a limit of the linter; production's limit for this expression is not measured.",
    fix: 'Shorten the chain: bind a value partway along it to a `let` or a function parameter, and read the rest of the chain from that name.',
  };
}

function defaultServiceTarget(ast: FirestoreRules): 'cloud.firestore' | 'firebase.storage' {
  if (isStorageServiceName(ast.service?.name)) {
    return 'firebase.storage';
  }
  return 'cloud.firestore';
}

function analyzeParsedRules(
  ast: FirestoreRules,
  source: string,
  options: LintOptions,
  warnings: LintWarning[],
  isSecondaryService = false,
  svcTarget: 'cloud.firestore' | 'firebase.storage' = defaultServiceTarget(ast),
  hasResolutionError = false,
): LintResult {
  const isStorage = isStorageServiceName(ast.service?.name);
  const allFunctions = collectDeclaredFunctions(ast);
  const serviceOnlyAst: FirestoreRules = isSecondaryService ? { ...ast, functions: [] } : ast;
  const ownFunctions = isSecondaryService ? collectDeclaredFunctions(serviceOnlyAst) : allFunctions;
  const allRules = collectServiceRules(ast.service);
  const scopes = collectRulesetScopes(ast);
  const fnScopes = new Map<FunctionDef, ReadonlyMap<string, FunctionDef>>(
    scopes.functions.map((s) => [s.fn, s.functions]),
  );
  const ruleScopes = new Map<AllowRule, ReadonlyMap<string, FunctionDef>>(
    scopes.rules.map((r) => [r.rule, r.functions]),
  );

  checkMemberChainLength(serviceOnlyAst, ownFunctions, warnings);

  let violations: CompileLimitViolation[];
  if (isSecondaryService) {
    violations = compileLimitViolations(serviceOnlyAst, { allowUnresolvedImports: true }).filter(
      (v) =>
        v.code !== 'UNSUPPORTED_RULES_VERSION' &&
        !(v.code === 'UNRESOLVED_MODULES' && v.functionName === undefined),
    );
  } else {
    violations = compileLimitViolations(serviceOnlyAst);
  }
  checkNestingDepth(violations, warnings);
  checkSlashStartsPath(violations, warnings);
  checkGlobMatchCount(violations, warnings);
  checkAdditionalCompileRejections(ast, violations, warnings, hasResolutionError);

  checkLetBindings(ownFunctions, warnings);
  checkSharedGates(allRules, warnings);

  const costEstimates = estimateExpressionCosts(ast);
  checkExpressionBudget(costEstimates.rules, warnings);
  checkLibraryCalls(ast, warnings);

  let callDepthScopes = scopes;
  if (isSecondaryService) {
    callDepthScopes = {
      functions: scopes.functions.filter((s) => s.label !== 'global scope'),
      rules: scopes.rules,
    };
  }
  const callDepths = checkCallDepth(callDepthScopes, warnings);

  checkGetCount(allRules, ruleScopes, fnScopes, warnings, isStorage);
  checkGetDuplication(allRules, ruleScopes, fnScopes, warnings, isStorage);

  warnings.push(...checkHallucinations(serviceOnlyAst, { allowDebug: options.allowDebug }));

  const { applicableRules, recursiveScopes } = collectRootAwarePolicyTargets(
    topLevelMatches(ast.service),
    ast.version,
    isStorage,
    warnings,
  );
  checkPermissiveRules(applicableRules, recursiveScopes, warnings, isStorage);
  checkRecursiveWildcardOpen(recursiveScopes, warnings, isStorage);

  if (options.testCases && options.testCases.length > 0) {
    checkRequestTimePinned(allRules, ruleScopes, fnScopes, options.testCases, warnings);
  }

  if (options.previousSource) {
    const prev = parseToASTOrError(options.previousSource);
    if (prev.ok) {
      const prevService = allServiceBlocks(prev.ast).find((s) => {
        if (svcTarget === 'firebase.storage') return isStorageServiceName(s.name);
        return s.name === svcTarget;
      });
      if (prevService) {
        const prevAst = resolveBundledModulesForAnalysis(
          withSingleService(prev.ast, prevService),
          options.previousSource,
          { targetService: svcTarget },
        );
        checkRulesWeakened(topLevelMatches(ast.service), topLevelMatches(prevAst.service), warnings);
      }
    }
  }

  let maxChain = { depth: 0, op: '' };
  let maxLets = { count: 0, fn: '' };
  for (const fn of allFunctions) {
    const chain = deepestChain(fn.body);
    if (chain.depth > maxChain.depth) maxChain = { depth: chain.depth, op: chain.op };
    if (fn.lets.length > maxLets.count) maxLets = { count: fn.lets.length, fn: fn.name };
  }

  let maxDepth = 0;
  for (const d of callDepths.values()) {
    if (d > maxDepth) maxDepth = d;
  }

  const emptyScope = new Map<string, FunctionDef>();
  let maxExprs = 0;
  for (const estimate of costEstimates.rules) {
    if (estimate.grantCost !== null && estimate.grantCost > maxExprs) maxExprs = estimate.grantCost;
  }
  let maxGets = 0;
  for (const r of allRules) {
    const fnMap = ruleScopes.get(r.rule) ?? emptyScope;
    const gets = countDocumentAccessCalls(r.rule.condition, fnMap, new Set(), fnScopes, isStorage);
    if (gets > maxGets) maxGets = gets;
  }

  return {
    warnings,
    metrics: {
      sourceSize: source.length,
      functionCount: allFunctions.length,
      allowRuleCount: allRules.length,
      maxChainDepth: maxChain.depth,
      maxChainOp: maxChain.op,
      maxLetBindings: maxLets.count,
      maxLetBindingsFunction: maxLets.fn,
      maxCallDepth: maxDepth,
      maxEstimatedExpressions: maxExprs,
      getCallCount: maxGets,
    },
  };
}

import type {
  Expression,
  FirestoreRules,
  FunctionDef,
  MatchBlock,
  SimulateFirestoreRulesHandler,
  TestCase,
} from 'pyric/rules/internal';
import { assembleRules, projectEvaluatedRule, renderLegacyDebugMessages, Timestamp } from 'pyric/rules/internal';
import type { FirestoreEventBus } from './event-bus.js';
import { makeError, type FirestoreSimError } from './errors.js';
import {
  proveListQuery,
  renderQueryRemediation,
  type QueryConstraints,
} from './list-query-proof.js';
import type { DocStore } from './local-state.js';
import { buildRequestEvent, type EmitRequestInput } from './request-events.js';
import { listQueryFromStructured } from './reads.js';
import {
  SimulatorUnsupportedError,
  unsupportedMessage,
} from './rules-evaluation.js';
import type { RulesState } from './rules-state.js';
import { buildRulesTestCase } from './rules-test-case.js';
import type { TriggerInfo } from './trigger-scope.js';
import type { Operation } from './writes.js';

export interface RulesListAuthorizerHost {
  readonly state: DocStore;
}

export interface ListAuthorizationRequest {
  /** Collection groups require a symbolic all-path proof, never row sampling. */
  collectionGroup?: boolean;
  path: string;
  auth: Operation['auth'];
  constraints: QueryConstraints;
  origin: 'listener' | 'user';
  bypassRules?: boolean;
  activityQuery?: unknown;
  triggeredBy?: TriggerInfo;
  /** Preserve the established request.time → event.at capture order. */
  timing?: { requestTime?: Timestamp; at: number };
}

export type ListAuthorizationResult =
  | { allowed: true }
  | { allowed: false; error: FirestoreSimError };

/**
 * Owns the shared list-rule proof, residual simulation, and request-event
 * policy used by listener and one-shot query reads.
 */
export class RulesListAuthorizer {
  constructor(
    private readonly events: FirestoreEventBus,
    private readonly rules: RulesState,
    private readonly simulator: SimulateFirestoreRulesHandler,
    private readonly host: RulesListAuthorizerHost,
  ) {}

  authorize(request: ListAuthorizationRequest): ListAuthorizationResult {
    const { path, auth, constraints, origin, triggeredBy } = request;
    const requestQuery = listQueryFromStructured(constraints);
    const requestDetail = {
      ...(request.bypassRules ? { admin: true } : {}),
      ...(requestQuery ? { query: requestQuery } : {}),
      ...(request.activityQuery !== undefined ? { activityQuery: request.activityQuery } : {}),
    };
    const detail = Object.keys(requestDetail).length > 0 ? requestDetail : undefined;
    const requestTime = request.timing?.requestTime ?? (
      request.bypassRules ? undefined : Timestamp.fromMillis(Date.now())
    );
    const evalAt = request.timing?.at ?? Date.now();

    if (request.bypassRules) {
      this.emitRequest({
        at: evalAt,
        evalMs: 0,
        method: 'list',
        path,
        auth,
        result: 'allow',
        debugMessages: [origin === 'listener'
          ? 'admin lens — rules bypassed'
          : 'admin lens — rules bypassed (Studio Gap #2)'],
        origin,
        ...(detail ? { detail } : {}),
        ...(triggeredBy ? { triggeredBy } : {}),
      });
      return { allowed: true };
    }

    const deployedAst = this.rules.ast();
    const evaluationAst = request.collectionGroup
      ? globalCollectionGroupRules(deployedAst)
      : deployedAst;
    if (request.collectionGroup && !evaluationAst) {
      const message =
        `list ${path} denied: symbolic collection-group proof is not supported; ` +
        'the query is rejected rather than authorizing from the currently stored rows';
      this.emitRequest({
        at: evalAt,
        evalMs: 0,
        method: 'list',
        path,
        auth,
        result: 'deny',
        debugMessages: [message],
        origin,
        ...(detail ? { detail } : {}),
        ...(triggeredBy ? { triggeredBy } : {}),
      });
      const error = makeError('permission-denied', message, {
        request: { method: 'list', path, auth },
        query: constraints,
      });
      this.emitUserDenial(origin, error);
      return { allowed: false, error };
    }

    const placeholderPath = `${path}/__listPlaceholder__`;
    const evaluationSource = request.collectionGroup
      ? assembleRules(evaluationAst!)
      : this.rules.source;
    const evalStart = performance.now();
    const proof = proveListQuery(evaluationAst, placeholderPath, auth, constraints);
    if (proof.kind === 'unprovable') {
      const message =
        `list ${path} denied: the query is statically unprovable for every possible ` +
        `result (rules are not filters), so the whole query is rejected — ${proof.reason}`;
      const remediation = renderQueryRemediation(proof.residual);
      this.emitRequest({
        at: evalAt,
        evalMs: performance.now() - evalStart,
        method: 'list',
        path,
        auth,
        result: 'deny',
        debugMessages: [message],
        origin,
        ...(detail ? { detail } : {}),
        ...(triggeredBy ? { triggeredBy } : {}),
      });
      const error = makeError('permission-denied', message, {
        request: { method: 'list', path, auth },
        query: constraints,
        ...(remediation ? { remediation } : {}),
      });
      this.emitUserDenial(origin, error);
      return { allowed: false, error };
    }

    const testCase = buildRulesTestCase(
      this.host.state,
      { method: 'list', path: placeholderPath, auth },
      requestTime!,
    );
    this.applyProof(testCase, proof, constraints);
    const simulation = this.simulator.simulate(evaluationSource, [testCase], {
      getDoc: (documentPath) => this.host.state.get(documentPath),
    });
    const evalMs = performance.now() - evalStart;
    if (!simulation.success) {
      this.emitRequest({
        at: evalAt,
        evalMs,
        method: 'list',
        path,
        auth,
        result: 'deny',
        debugMessages: [`Simulation error: ${simulation.error.message}`],
        origin,
        ...(detail ? { detail } : {}),
        ...(triggeredBy ? { triggeredBy } : {}),
      });
      return {
        allowed: false,
        error: makeError('permission-denied', `list ${path} simulator error`, {
          request: { method: 'list', path, auth },
        }),
      };
    }

    const result = simulation.data.results[0]!;
    const debugMessages = renderLegacyDebugMessages(result);
    if (result.state === 'UNSUPPORTED') {
      this.emitRequest({
        at: evalAt,
        evalMs,
        method: 'list',
        path,
        auth,
        result: 'unsupported',
        debugMessages,
        origin,
        ...(detail ? { detail } : {}),
        ...(triggeredBy ? { triggeredBy } : {}),
      });
      throw new SimulatorUnsupportedError(
        unsupportedMessage('list', path, debugMessages),
        'list',
        path,
        debugMessages,
      );
    }

    if (result.state !== 'PASSED') {
      this.emitRequest({
        at: evalAt,
        evalMs,
        method: 'list',
        path,
        auth,
        result: 'deny',
        debugMessages,
        evaluatedRule: projectEvaluatedRule(result),
        origin,
        ...(detail ? { detail } : {}),
        ...(triggeredBy ? { triggeredBy } : {}),
      });
      const error = makeError('permission-denied', `list ${path} denied by rules`, {
        request: { method: 'list', path, auth },
      });
      this.emitUserDenial(origin, error);
      return { allowed: false, error };
    }

    this.emitRequest({
      at: evalAt,
      evalMs,
      method: 'list',
      path,
      auth,
      result: 'allow',
      debugMessages,
      evaluatedRule: projectEvaluatedRule(result),
      origin,
      ...(detail ? { detail } : {}),
      ...(triggeredBy ? { triggeredBy } : {}),
    });
    return { allowed: true };
  }

  private applyProof(
    testCase: TestCase,
    proof: { kind: 'provable'; syntheticResource?: Record<string, unknown> } | { kind: 'no-rule' },
    constraints: QueryConstraints,
  ): void {
    if (proof.kind === 'provable' && proof.syntheticResource) {
      testCase.resource = proof.syntheticResource;
    }
    if (constraints.limit != null || constraints.offset != null || constraints.orderBy != null) {
      testCase.query = {
        ...(constraints.limit != null ? { limit: constraints.limit } : {}),
        ...(constraints.offset != null ? { offset: constraints.offset } : {}),
        ...(constraints.orderBy != null ? { orderBy: constraints.orderBy } : {}),
      };
    }
  }

  private emitRequest(input: EmitRequestInput): void {
    if (!this.events.request.hasSubscribers) return;
    this.events.request.emit(buildRequestEvent(input));
  }

  private emitUserDenial(origin: ListAuthorizationRequest['origin'], error: FirestoreSimError): void {
    if (origin === 'user') this.events.denial.emit(error);
  }
}

/**
 * A root-level `{document=**}` match governs every possible collection-group
 * result. Isolating only those universal blocks prevents a concrete root path
 * rule from accidentally authorizing the group's unbounded nested scope.
 * Group-specific `/{path=**}/items/{id}` proofs remain fail-closed until the
 * rules matcher can evaluate recursive wildcards with trailing segments.
 */
function globalCollectionGroupRules(ast: FirestoreRules | null): FirestoreRules | null {
  if (!ast) return null;
  const outerFunctions = [
    ...(ast.functions ?? []),
    ...(ast.service.functions ?? []),
    ...ast.service.match.functions,
  ];
  const children = ast.service.match.children.filter((block) =>
    block.path.segments.length === 1 &&
    block.path.segments[0]?.type === 'recursive' &&
    globalRuleIsPathInvariant(block, outerFunctions) &&
    block.allows.some((rule) => rule.operations.some((operation) =>
      operation === 'list' || operation === 'read'
    )),
  );
  if (children.length === 0) return null;
  return {
    ...ast,
    service: {
      ...ast.service,
      match: {
        ...ast.service.match,
        children,
      },
    },
  };
}

function globalRuleIsPathInvariant(
  block: MatchBlock,
  outerFunctions: readonly FunctionDef[],
): boolean {
  const segment = block.path.segments[0];
  if (segment?.type !== 'recursive') return false;
  const listRules = block.allows.filter((rule) => rule.operations.some((operation) =>
    operation === 'list' || operation === 'read'
  ));
  const expressions = [
    ...listRules.map((rule) => rule.condition),
    ...[...outerFunctions, ...block.functions].flatMap((fn) => [
      ...fn.lets.map((binding) => binding.value),
      fn.body,
    ]),
  ];
  return expressions.every((expression) =>
    !expressionDependsOnPath(expression, segment.name)
  );
}

function expressionDependsOnPath(expression: Expression, recursiveName: string): boolean {
  const depends = (candidate: Expression): boolean =>
    expressionDependsOnPath(candidate, recursiveName);
  switch (expression.type) {
    case 'literal':
      return false;
    case 'identifier':
      return expression.name === recursiveName;
    case 'memberAccess':
      return (
        expression.property === 'path' &&
        expression.object.type === 'identifier' &&
        expression.object.name === 'request'
      ) || depends(expression.object);
    case 'methodCall':
      return depends(expression.object) || expression.args.some(depends);
    case 'bracketAccess':
      return (
        expression.object.type === 'identifier' &&
        expression.object.name === 'request' &&
        expression.index.type === 'literal' &&
        expression.index.value === 'path'
      ) || depends(expression.object) || depends(expression.index);
    case 'sliceAccess':
      return depends(expression.object) || depends(expression.start) || depends(expression.end);
    case 'binaryOp':
      return depends(expression.left) || depends(expression.right);
    case 'unaryOp':
      return depends(expression.operand);
    case 'ternary':
      return depends(expression.condition) || depends(expression.consequent) || depends(expression.alternate);
    case 'inExpr':
      return depends(expression.element) || depends(expression.collection);
    case 'isExpr':
      return depends(expression.value);
    case 'listLiteral':
      return expression.elements.some(depends);
    case 'mapLiteral':
      return expression.entries.some((entry) => depends(entry.key) || depends(entry.value));
    case 'pathLiteral':
      return expression.segments.some((segment) => typeof segment !== 'string' && depends(segment));
    case 'functionCall':
      return expression.args.some(depends);
  }
}

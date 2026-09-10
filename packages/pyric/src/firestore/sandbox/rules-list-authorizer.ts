import { queryExecutionDiagnostic, type QueryExecutionSpec } from './query-execution.js';
import type { EvaluatedRuleInfo } from 'pyric/rules/internal';
import type { QueryProofDiagnostic } from '../../sandbox/types/query-proof.js';
import type {
  SimulateFirestoreRulesHandler,
  TestCase,
} from 'pyric/rules/internal';
import { assembleRules, projectEvaluatedRule, renderLegacyDebugMessages, Timestamp } from 'pyric/rules/internal';
import { proveGlobalCollectionGroupRules } from './collection-group-rule-proof.js';
import type { FirestoreEventBus } from './event-bus.js';
import { makeError, type FirestoreSimError } from './errors.js';
import {
  proveListQuery,
  renderQueryRemediation,
  type ListProofVerdict,
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
import { SandboxClock } from '../../sandbox/clock.js';

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
  execution?: QueryExecutionSpec;
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
    /** The sandbox's clock, read for every server-set time this produces.
     *  Defaults to a private wall clock for a standalone construction. */
    private readonly clock: SandboxClock = new SandboxClock(),
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
      request.bypassRules ? undefined : Timestamp.fromMillis(this.clock.now())
    );
    const evalAt = request.timing?.at ?? this.clock.now();

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
      ? proveGlobalCollectionGroupRules(deployedAst)
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
    const evalStart = performance.now();
    const proof = proveListQuery(evaluationAst, placeholderPath, auth, constraints, this.rules.source);
    const isUnprovable = proof.kind === 'unprovable';
    if (isUnprovable) {
      return this.denyQuery(request, proof, evalAt, performance.now() - evalStart, detail);
    }

    const evaluationSource = proof.kind === 'provable'
      ? assembleRules(proof.evaluationAst)
      : request.collectionGroup
        ? assembleRules(evaluationAst!)
        : this.rules.source;

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

    const isNotPassed = result.state !== 'PASSED';
    if (isNotPassed) {
      return this.denyQuery(request, proof, evalAt, evalMs, detail,
        debugMessages, projectEvaluatedRule(result));
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

  /** Combine local proof failures with actual residual evaluation, without
   * ever putting rejected rules back into the authorization AST. */
  private denyQuery(
    request: ListAuthorizationRequest,
    proof: ListProofVerdict,
    at: number,
    evalMs: number,
    detail: EmitRequestInput['detail'],
    residualReasons: string[] = [],
    evaluatedRule?: EvaluatedRuleInfo,
  ): ListAuthorizationResult {
    const failures = proof.kind === 'no-rule' ? [] : proof.failures;
    const primary = failures.find(failure => failure.kind !== 'constraints-not-satisfied') ?? failures[0];
    const queryProof: QueryProofDiagnostic = {
      kind: primary?.kind ?? (proof.kind === 'no-rule' ? 'no-rule' : 'residual-denied'),
      failures,
      query: request.activityQuery ?? (request.execution ? queryExecutionDiagnostic(request.execution) : undefined),
    };
    const message = primary
      ? `list ${request.path} denied: Pyric found the query statically unprovable — ${primary.reason}`
      : `list ${request.path} denied by rules`;
    // The projected AST can have empty match blocks. Its no-allow summary
    // does not describe the deployed ruleset when proof rejected siblings.
    const reasons = primary
      ? [message, ...residualReasons.filter(reason => !reason.startsWith('No allow rules found'))]
      : residualReasons;
    const remediation = primary ? renderQueryRemediation(primary.residual) : undefined;
    const error = makeError('permission-denied', message, {
      request: { method: 'list', path: request.path, auth: request.auth },
      query: request.constraints,
      queryProof,
      ...(remediation ? { remediation } : {}),
      ...(primary?.rule || evaluatedRule ? { rule: primary?.rule ?? evaluatedRule } : {}),
    });
    this.emitRequest({
      at, evalMs, method: 'list', path: request.path, auth: request.auth,
      result: 'deny', debugMessages: reasons, queryProof,
      ...(evaluatedRule ? { evaluatedRule } : {}),
      origin: request.origin,
      ...(detail ? { detail } : {}),
      ...(request.triggeredBy ? { triggeredBy: request.triggeredBy } : {}),
    });
    this.emitUserDenial(request.origin, error);
    return { allowed: false, error };
  }

  private applyProof(
    testCase: TestCase,
    proof: Exclude<ListProofVerdict, { kind: 'unprovable' }>,
    constraints: QueryConstraints,
  ): void {
    if (proof.kind === 'provable') {
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

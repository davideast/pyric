import type { SimulateFirestoreRulesHandler, TestCase } from 'pyric/rules/internal';
import { projectEvaluatedRule, renderLegacyDebugMessages, Timestamp } from 'pyric/rules/internal';
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
  /** Concrete collection paths that the captured execution scope can read. */
  matchPaths?: readonly string[];
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

    const matchPaths = request.matchPaths?.length ? request.matchPaths : [path];
    const evalStart = performance.now();
    const evaluations = matchPaths.map((matchPath) => ({
      placeholderPath: `${matchPath}/__listPlaceholder__`,
      proof: proveListQuery(
        this.rules.ast(),
        `${matchPath}/__listPlaceholder__`,
        auth,
        constraints,
      ),
    }));
    const unprovable = evaluations.find((evaluation) => evaluation.proof.kind === 'unprovable');
    if (unprovable?.proof.kind === 'unprovable') {
      const message =
        `list ${path} denied: the query is statically unprovable for every possible ` +
        `result (rules are not filters), so the whole query is rejected — ${unprovable.proof.reason}`;
      const remediation = renderQueryRemediation(unprovable.proof.residual);
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

    const testCases = evaluations.map(({ placeholderPath, proof }) => {
      if (proof.kind === 'unprovable') {
        throw new Error('Unprovable list query reached residual simulation');
      }
      const testCase = buildRulesTestCase(
        this.host.state,
        { method: 'list', path: placeholderPath, auth },
        requestTime!,
      );
      this.applyProof(testCase, proof, constraints);
      return testCase;
    });
    const simulation = this.simulator.simulate(this.rules.source, testCases, {
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

    const results = simulation.data.results;
    const result = results.find((candidate) => candidate.state !== 'PASSED') ?? results[0]!;
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

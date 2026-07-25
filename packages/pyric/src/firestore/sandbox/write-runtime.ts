import type { DocStore, DocumentData } from './local-state.js';
import { applyMerge } from './field-merge.js';
import type {
  SimulateFirestoreRulesHandler,
  TestCase,
  TestFirestoreRulesResult,
  Timestamp,
} from 'pyric/rules/internal';
import type { RulesState } from './rules-state.js';
import type { EventLog } from './event-log.js';
import type { FirestoreEventBus } from './event-bus.js';
import type { TriggerScope } from './trigger-scope.js';
import type { FirestoreSimError } from './errors.js';
import type { Operation } from './writes.js';
import type { EventProvenance } from '../../sandbox/types/events.js';
import { buildRequestEvent, nextRequestEventId, type EmitRequestInput } from './request-events.js';
import type { SentinelHit } from './sentinel-capture.js';
import { buildRulesTestCase } from './rules-test-case.js';
import { simulateRules } from './rules-simulator.js';
import { registerDefaultConverters } from './value-resolver.js';

registerDefaultConverters();

export interface WriteRuntimeHost {
  readonly state: DocStore;
  notifyListenersForPaths(paths: Set<string>): void;
}

/** Shared rules, event, state, and notification policy for atomic write executors. */
export class WriteRuntime {
  constructor(
    private readonly host: WriteRuntimeHost,
    private readonly rules: RulesState,
    private readonly simulator: SimulateFirestoreRulesHandler,
    readonly eventLog: EventLog,
    private readonly events: FirestoreEventBus,
    private readonly triggerScope: TriggerScope,
  ) {}

  get state(): DocStore {
    return this.host.state;
  }

  emitDenial(error: FirestoreSimError): void {
    this.events.denial.emit(error);
  }

  emitRequest(input: EmitRequestInput): void {
    if (!this.events.request.hasSubscribers) return;
    this.events.request.emit(buildRequestEvent(input));
  }

  emitWrite(input: {
    method: 'create' | 'update' | 'set' | 'delete';
    path: string;
    auth: Operation['auth'];
    data?: Record<string, unknown>;
    priorState: Record<string, unknown> | null;
    nextState: Record<string, unknown> | null;
    groupId?: string;
    groupKind?: 'batch' | 'transaction';
    sentinels?: SentinelHit[];
    autoId?: string;
    requestTime: Timestamp;
    detail?: { admin?: boolean } & Record<string, unknown>;
    provenance?: EventProvenance;
  }): void {
    if (!this.events.write.hasSubscribers) return;
    this.events.write.emit({
      kind: 'write',
      id: nextRequestEventId().replace(/^req-/, 'wr-'),
      at: Date.now(),
      method: input.method,
      path: input.path,
      auth: input.auth
        ? { uid: input.auth.uid, ...(input.auth.token ? { token: input.auth.token } : {}) }
        : null,
      ...(input.data !== undefined ? { data: input.data } : {}),
      priorState: input.priorState,
      nextState: input.nextState,
      ...(input.groupId !== undefined ? { groupId: input.groupId } : {}),
      ...(input.groupKind !== undefined ? { groupKind: input.groupKind } : {}),
      ...(input.sentinels && input.sentinels.length > 0 ? { sentinels: input.sentinels } : {}),
      ...(input.autoId !== undefined ? { autoId: input.autoId } : {}),
      requestTime: { seconds: input.requestTime.seconds, nanoseconds: input.requestTime.nanos },
      ...(input.detail !== undefined ? { detail: input.detail } : {}),
      ...(input.provenance ?? {}),
    });
  }

  capturePriors(paths: readonly string[]): Record<string, DocumentData | null> {
    const priors: Record<string, DocumentData | null> = {};
    for (const path of paths) {
      const prior = this.state.get(path);
      priors[path] = prior ? { ...prior } : null;
    }
    return priors;
  }

  runSimulate(
    testCases: TestCase[],
    bypassRules: boolean | undefined,
    batchProjection?: Map<string, DocumentData | null>,
  ): TestFirestoreRulesResult {
    return simulateRules(
      this.state,
      this.rules,
      this.simulator,
      testCases,
      bypassRules,
      batchProjection,
    );
  }

  private isReadOnlyMethod(method: string): boolean {
    return method === 'get' || method === 'list';
  }

  private resolvePriorDocumentState(
    path: string,
    projection: Map<string, DocumentData | null>,
    databaseState: DocStore,
  ): DocumentData | null {
    if (projection.has(path)) {
      const projectedState = projection.get(path);
      return projectedState ?? null;
    }
    if (databaseState.exists(path)) {
      const existingDatabaseState = databaseState.get(path);
      return existingDatabaseState ?? null;
    }
    return null;
  }

  private computeProjectedUpdate(
    priorState: DocumentData | null,
    incomingData: DocumentData | undefined,
  ): DocumentData | null {
    if (priorState === null) {
      return null;
    }
    const effectiveIncomingData = incomingData ?? {};
    return applyMerge(priorState, effectiveIncomingData);
  }

  private computeProjectedOverwrite(
    priorState: DocumentData | null,
    incomingData: DocumentData | undefined,
  ): DocumentData {
    const baseState = priorState ?? {};
    const effectiveIncomingData = incomingData ?? {};
    return applyMerge(baseState, effectiveIncomingData);
  }

  buildBatchProjection(testCases: TestCase[]): Map<string, DocumentData | null> {
    const projection = new Map<string, DocumentData | null>();
    for (const testCase of testCases) {
      if (this.isReadOnlyMethod(testCase.method)) {
        continue;
      }
      if (testCase.method === 'delete') {
        projection.set(testCase.path, null);
        continue;
      }
      const priorState = this.resolvePriorDocumentState(testCase.path, projection, this.state);
      if (testCase.method === 'update') {
        const updatedDocument = this.computeProjectedUpdate(priorState, testCase.data);
        projection.set(testCase.path, updatedDocument);
      } else {
        const overwrittenDocument = this.computeProjectedOverwrite(priorState, testCase.data);
        projection.set(testCase.path, overwrittenDocument);
      }
    }
    return projection;
  }

  buildTestCase(operation: Operation, serverTime?: Timestamp): TestCase {
    return buildRulesTestCase(this.state, operation, serverTime);
  }

  notify(method: string, path: string, touched: Set<string>): void {
    this.triggerScope.run(
      { method, path },
      () => this.host.notifyListenersForPaths(touched),
    );
  }
}

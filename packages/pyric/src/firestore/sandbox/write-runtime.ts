import type { BatchOperation, DocStore, DocumentData } from './local-state.js';
import { applyMerge, applyUpdate } from './field-merge.js';
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
import type { EventProvenance, WriteSandboxEvent } from '../../sandbox/types/events.js';
import { buildRequestEvent, nextRequestEventId, type EmitRequestInput } from './request-events.js';
import type { SentinelHit } from './sentinel-capture.js';
import { buildRulesTestCase } from './rules-test-case.js';
import { simulateRules } from './rules-simulator.js';
import { partitionDeletes, registerDefaultConverters } from './value-resolver.js';
import { SandboxClock } from '../../sandbox/clock.js';

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
    /** The sandbox's clock, read for every server-set time this produces.
     *  Defaults to a private wall clock for a standalone construction. */
    readonly clock: SandboxClock = new SandboxClock(),
  ) {}

  get state(): DocStore {
    return this.host.state;
  }

  emitDenial(error: FirestoreSimError): void {
    this.events.denial.emit(error);
  }

  emitRequest(input: EmitRequestInput): void {
    const hasNoSubscribers = !this.events.request.hasSubscribers;
    if (hasNoSubscribers) return;
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
    const hasNoSubscribers = !this.events.write.hasSubscribers;
    if (hasNoSubscribers) return;
    const event: WriteSandboxEvent = {
      kind: 'write',
      id: nextRequestEventId().replace(/^req-/, 'wr-'),
      at: this.clock.now(),
      method: input.method,
      path: input.path,
      auth: null,
      priorState: input.priorState,
      nextState: input.nextState,
      requestTime: { seconds: input.requestTime.seconds, nanoseconds: input.requestTime.nanos },
    };
    const { auth } = input;
    const hasAuth = auth !== null;
    if (hasAuth) {
      event.auth = { uid: auth.uid };
      const hasToken = Boolean(auth.token);
      if (hasToken) event.auth.token = auth.token;
    }
    const hasData = input.data !== undefined;
    if (hasData) event.data = input.data;
    const hasGroupId = input.groupId !== undefined;
    if (hasGroupId) event.groupId = input.groupId;
    const hasGroupKind = input.groupKind !== undefined;
    if (hasGroupKind) event.groupKind = input.groupKind;
    const hasSentinels = input.sentinels !== undefined && input.sentinels.length > 0;
    if (hasSentinels) event.sentinels = input.sentinels;
    const hasAutoId = input.autoId !== undefined;
    if (hasAutoId) event.autoId = input.autoId;
    const hasDetail = input.detail !== undefined;
    if (hasDetail) event.detail = input.detail;
    this.events.write.emit({ ...event, ...input.provenance });
  }

  capturePriors(paths: readonly string[]): Record<string, DocumentData | null> {
    const priors: Record<string, DocumentData | null> = {};
    for (const path of paths) {
      const prior = this.state.get(path);
      const documentExists = prior !== null;
      priors[path] = documentExists ? { ...prior } : null;
    }
    return priors;
  }

  captureEvidence(result: import('pyric/rules/internal').TestResult) {
    return this.rules.captureEvidence(result);
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

  private resolvePriorDocumentState(
    path: string,
    projection: Map<string, DocumentData | null>,
    databaseState: DocStore,
  ): DocumentData | null {
    const hasProjection = projection.has(path);
    if (hasProjection) {
      const projectedState = projection.get(path);
      return projectedState ?? null;
    }
    const documentExists = databaseState.exists(path);
    if (documentExists) {
      const existingDatabaseState = databaseState.get(path);
      return existingDatabaseState ?? null;
    }
    return null;
  }

  private computeProjectedUpdate(
    priorState: DocumentData | null,
    incomingData: DocumentData | undefined,
  ): DocumentData | null {
    const documentMissing = priorState === null;
    if (documentMissing) {
      return null;
    }
    const effectiveIncomingData = incomingData ?? {};
    return applyUpdate(priorState, effectiveIncomingData);
  }

  private computeProjectedOverwrite(
    priorState: DocumentData | null,
    incomingData: DocumentData | undefined,
  ): DocumentData {
    const baseState = priorState ?? {};
    const effectiveIncomingData = incomingData ?? {};
    return applyMerge(baseState, effectiveIncomingData);
  }

  /** Project write intent before the rules vocabulary reduces set to create/update. */
  buildBatchProjection(
    operations: BatchOperation[],
    projection = new Map<string, DocumentData | null>(),
  ): Map<string, DocumentData | null> {
    for (const operation of operations) {
      const isReplacement = operation.method === 'set';
      if (isReplacement) {
        projection.set(operation.path, partitionDeletes(operation.data ?? {}).writes);
        continue;
      }
      const isDelete = operation.method === 'delete';
      if (isDelete) {
        projection.set(operation.path, null);
        continue;
      }
      const priorState = this.resolvePriorDocumentState(operation.path, projection, this.state);
      const isUpdate = operation.method === 'update';
      if (isUpdate) {
        const updatedDocument = this.computeProjectedUpdate(priorState, operation.data);
        projection.set(operation.path, updatedDocument);
      } else {
        const overwrittenDocument = this.computeProjectedOverwrite(priorState, operation.data);
        projection.set(operation.path, overwrittenDocument);
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

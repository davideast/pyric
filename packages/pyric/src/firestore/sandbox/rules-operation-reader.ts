import type { DocStore, DocumentData } from './local-state.js';
import type { SimulateFirestoreRulesHandler } from 'pyric/rules/internal';
import {
  projectEvaluatedRule,
  renderLegacyDebugMessages,
  Timestamp,
} from 'pyric/rules/internal';
import type { Operation, OperationResult, ReadOperation } from './writes.js';
import { makeError, type FirestoreSimError } from './errors.js';
import type { FirestoreEventBus } from './event-bus.js';
import type { RulesState } from './rules-state.js';
import { buildRequestEvent, type EmitRequestInput } from './request-events.js';
import {
  SimulatorUnsupportedError,
  unsupportedMessage,
} from './rules-evaluation.js';
import { buildRulesTestCase } from './rules-test-case.js';
import { EventLog } from './event-log.js';
import { simulateRules } from './rules-simulator.js';

interface RulesOperationReaderHost {
  readonly state: DocStore;
}

/** Rules-gated user `get`/`list` execution, including history and events. */
export class RulesOperationReader {
  constructor(
    private readonly events: FirestoreEventBus,
    private readonly rules: RulesState,
    private readonly simulator: SimulateFirestoreRulesHandler,
    private readonly host: RulesOperationReaderHost,
    private readonly eventLog: EventLog,
  ) {}

  private get state(): DocStore {
    return this.host.state;
  }

  private emitRequest(input: EmitRequestInput): void {
    if (!this.events.request.hasSubscribers) return;
    this.events.request.emit(buildRequestEvent(input));
  }

  private emitDenial(error: FirestoreSimError): void {
    this.events.denial.emit(error);
  }
  execute(operation: ReadOperation): OperationResult {
    const { method, path, auth, bypassRules } = operation;
    const detail = bypassRules ? { admin: true } : undefined;

    // No data to resolve on reads, but still pin a serverTime so the
    // handler's `request.time` is deterministic relative to anything
    // observed by debug messages (Item 1).
    const readServerTime = Timestamp.fromMillis(Date.now());
    const testCase = buildRulesTestCase(this.state, operation, readServerTime);
    // Issue #307 — time the simulate call for RequestEvent.evalMs.
    const evalAt = Date.now();
    const evalStart = performance.now();
    const simResult = simulateRules(
      this.state,
      this.rules,
      this.simulator,
      [testCase],
      bypassRules,
    );
    const evalMs = performance.now() - evalStart;

    if (!simResult.success) {
      const event = this.eventLog.append({
        type: 'single', method, path, auth: auth ? { uid: auth.uid } : null,
        allowed: false, debugMessages: [`Simulation error: ${simResult.error.message}`],
      });
      // Issue #307 — simulator failures are still requests worth surfacing.
      this.emitRequest({
        at: evalAt, evalMs, method, path, auth, result: 'deny',
        debugMessages: [`Simulation error: ${simResult.error.message}`],
        origin: 'user',
        ...(detail ? { detail } : {}),
      });
      return { allowed: false, debugMessages: [simResult.error.message], event };
    }

    const result = simResult.data.results[0];
    if (result.state === 'UNSUPPORTED') {
      // Issue #307 — surface the eval-time event BEFORE throwing so
      // subscribers see the unsupported request alongside everything else.
      this.emitRequest({
        at: evalAt, evalMs, method, path, auth, result: 'unsupported',
        debugMessages: renderLegacyDebugMessages(result), origin: 'user',
        ...(detail ? { detail } : {}),
      });
      throw new SimulatorUnsupportedError(
        unsupportedMessage(method, path, renderLegacyDebugMessages(result)),
        method, path, renderLegacyDebugMessages(result),
      );
    }
    const isAllowed = result.state === 'PASSED';
    let readData: DocumentData | null | undefined;
    if (isAllowed) {
      readData = method === 'get' ? this.state.get(path) : this.state.list(path) as unknown as DocumentData;
    }

    const event = this.eventLog.append({
      type: 'single', method, path, auth: auth ? { uid: auth.uid } : null,
      allowed: isAllowed, debugMessages: renderLegacyDebugMessages(result),
    });

    // Item 6: reads only fail with permission-denied (no structural
    // not-found here — read of a missing doc is allowed-with-empty
    // by Firestore's contract; the rule decides visibility).
    const out: OperationResult = {
      allowed: isAllowed,
      data: isAllowed ? readData : undefined,
      debugMessages: renderLegacyDebugMessages(result),
      event,
    };
    if (!isAllowed) {
      // Item 6+: surface the eval-time request + resource on the
      // error so callers (sandbox / playground) can render a "why
      // did this denial happen" frame without re-deriving state.
      // For `list`, `resource` is intentionally omitted — the rule
      // evaluated against a collection, not a single doc.
      const reqRead: { method: 'get' | 'list'; path: string; auth: Operation['auth'] } =
        { method, path, auth };
      const resRead = method === 'get'
        ? { data: this.state.get(path), exists: this.state.get(path) !== null }
        : undefined;
      out.error = makeError(
        'permission-denied',
        `${method} ${path} denied by rules`,
        { request: reqRead, ...(resRead ? { resource: resRead } : {}) },
      );
      this.emitDenial(out.error);
    }
    // Issue #307 — emit the request event for every read, allow or deny.
    // resourceBefore mirrors what the rule saw on `resource`: populated for
    // `get` (the single doc); omitted for `list` (the rule didn't evaluate
    // against a single resource).
    this.emitRequest({
      at: evalAt, evalMs, method, path, auth,
      result: isAllowed ? 'allow' : 'deny',
      debugMessages: renderLegacyDebugMessages(result),
      evaluatedRule: projectEvaluatedRule(result),
      origin: 'user',
      ...(method === 'get'
        ? { resourceBefore: { data: this.state.get(path), exists: this.state.get(path) !== null } }
        : {}),
      ...(detail ? { detail } : {}),
    });
    return out;
  }

}

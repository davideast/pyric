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
    let detail: { admin: true } | undefined = undefined;
    const isBypass = bypassRules === true;
    if (isBypass) {
      detail = { admin: true };
    }

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

    let authPayload: { uid: string } | null = null;
    const isAuthDefined = auth !== undefined;
    const isAuthNotNull = auth !== null;
    if (isAuthDefined) {
      if (isAuthNotNull) {
        authPayload = { uid: auth!.uid };
      }
    }

    const isSuccess = simResult.success === true;
    if (isSuccess === false) {
      const event = this.eventLog.append({
        type: 'single', method, path, auth: authPayload,
        allowed: false, debugMessages: [`Simulation error: ${simResult.error.message}`],
      });
      // Issue #307 — simulator failures are still requests worth surfacing.
      const failReqEvent: any = {
        at: evalAt, evalMs, method, path, auth, result: 'deny',
        debugMessages: [`Simulation error: ${simResult.error.message}`],
        origin: 'user',
      };
      const hasDetail = detail !== undefined;
      if (hasDetail) {
        failReqEvent.detail = detail;
      }
      this.emitRequest(failReqEvent);
      return { allowed: false, debugMessages: [simResult.error.message], event };
    }

    const result = simResult.data.results[0];
    const isUnsupported = result.state === 'UNSUPPORTED';
    if (isUnsupported) {
      // Issue #307 — surface the eval-time event BEFORE throwing so
      // subscribers see the unsupported request alongside everything else.
      const unsupReqEvent: any = {
        at: evalAt, evalMs, method, path, auth, result: 'unsupported',
        debugMessages: renderLegacyDebugMessages(result), origin: 'user',
      };
      const hasDetail = detail !== undefined;
      if (hasDetail) {
        unsupReqEvent.detail = detail;
      }
      this.emitRequest(unsupReqEvent);
      throw new SimulatorUnsupportedError(
        unsupportedMessage(method, path, renderLegacyDebugMessages(result)),
        method, path, renderLegacyDebugMessages(result),
      );
    }
    const isAllowed = result.state === 'PASSED';
    let readData: DocumentData | null | undefined = undefined;
    if (isAllowed) {
      const isGet = method === 'get';
      if (isGet) {
        readData = this.state.get(path);
      } else {
        readData = this.state.list(path) as unknown as DocumentData;
      }
    }

    const event = this.eventLog.append({
      type: 'single', method, path, auth: authPayload,
      allowed: isAllowed, debugMessages: renderLegacyDebugMessages(result),
    });

    // Item 6: reads only fail with permission-denied (no structural
    // not-found here — read of a missing doc is allowed-with-empty
    // by Firestore's contract; the rule decides visibility).
    const out: OperationResult = {
      allowed: isAllowed,
      debugMessages: renderLegacyDebugMessages(result),
      event,
    };
    if (isAllowed) {
      out.data = readData;
    }
    const evalRule = projectEvaluatedRule(result);
    if (isAllowed === false) {
      // Item 6+: surface the eval-time request + resource on the
      // error so callers (sandbox / playground) can render a "why
      // did this denial happen" frame without re-deriving state.
      // For `list`, `resource` is intentionally omitted — the rule
      // evaluated against a collection, not a single doc.
      const reqRead: { method: 'get' | 'list'; path: string; auth: Operation['auth'] } =
        { method, path, auth };
      const errExtras: {
        request: { method: 'get' | 'list'; path: string; auth: Operation['auth'] };
        resource?: { data: DocumentData | null; exists: boolean };
        rule?: unknown;
      } = { request: reqRead };
      const isMethodGet = method === 'get';
      if (isMethodGet) {
        const docData = this.state.get(path);
        const docExists = docData !== null;
        errExtras.resource = { data: docData, exists: docExists };
      }
      const hasRule = evalRule !== undefined;
      if (hasRule) {
        errExtras.rule = evalRule;
      }
      out.error = makeError(
        'permission-denied',
        `${method} ${path} denied by rules`,
        errExtras as any,
      );
      this.emitDenial(out.error);
    }
    // Issue #307 — emit the request event for every read, allow or deny.
    // resourceBefore mirrors what the rule saw on `resource`: populated for
    // `get` (the single doc); omitted for `list` (the rule didn't evaluate
    // against a single resource).
    let resultStr: 'allow' | 'deny' = 'deny';
    if (isAllowed) {
      resultStr = 'allow';
    }
    const reqEvent: {
      at: number;
      evalMs: number;
      method: 'get' | 'list';
      path: string;
      auth: any;
      result: 'allow' | 'deny';
      debugMessages: string[];
      evaluatedRule?: unknown;
      origin: 'user';
      resourceBefore?: { data: DocumentData | null; exists: boolean };
      detail?: unknown;
    } = {
      at: evalAt, evalMs, method, path, auth,
      result: resultStr,
      debugMessages: renderLegacyDebugMessages(result),
      evaluatedRule: evalRule,
      origin: 'user',
    };
    const isEventGet = method === 'get';
    if (isEventGet) {
      const docData = this.state.get(path);
      const docExists = docData !== null;
      reqEvent.resourceBefore = { data: docData, exists: docExists };
    }
    const hasDetail = detail !== undefined;
    if (hasDetail) {
      reqEvent.detail = detail;
    }
    this.emitRequest(reqEvent as any);
    return out;
  }

}

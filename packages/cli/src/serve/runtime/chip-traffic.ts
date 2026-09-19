import { EventHistory, OBSERVATION_HISTORY_LIMITS } from 'pyric/sandbox/internal';
import type { AiRequestObservation } from 'pyric/sandbox/internal';
/**
 * The chip's Traffic view: what the page just asked the sandbox for, and what
 * Security Rules said about it.
 *
 * No new protocol operation is needed for this. The page already delivers every
 * sandbox event to the chip — the same stream the Listeners mode folds — and
 * each request, service operation, and listener attach in it already carries a
 * canonical Rules disposition. This module projects that stream into the one
 * row shape Traffic draws and keeps a bounded tail of it, so a long-running
 * page costs a fixed amount of memory.
 *
 * The verdict is coarse on purpose. A developer reading Traffic wants to know
 * which line went wrong; the full disposition, the rule that matched, and the
 * payload are Studio's job, which is where a row's click goes.
 */
import type { SandboxEvent, RulesDisposition } from 'pyric/sandbox';
import { toOperationRecord } from 'pyric/sandbox';
import { captureIndexQuery, captureDatabaseIndexQuery, type ServiceIndexQuery } from 'pyric/sandbox/internal';

/** One line of the Traffic view. */
export interface ChipRequest {
  aiRequest?: AiRequestObservation;
  /** The sandbox event's own id, which is also Studio's filter for the row. */
  id: string;
  /** Wall-clock at the request, ms since epoch. */
  at: number;
  /** The service, or `null` for a failure that names no call. */
  service: string | null;
  /** The method, or `null` for a failure that names no call. */
  method: string | null;
  /** The target, or `null` when the operation names none. */
  path: string | null;
  /** What names the row when there is no call to name it. */
  label?: string | null;
  /**
   * `denied` is a Rules verdict, `error` any other failure the sandbox raised
   * against the same call, `ok` everything that went through.
   */
  verdict: 'ok' | 'denied' | 'error' | 'unsupported';
  /** Identity is context, never an explanation of the rules decision. */
  identity: string | null;
  rulesEvidence?: Extract<SandboxEvent, { kind: 'request' }>['rulesEvidence'];
  rules?: RulesDisposition;
  evidenceExpired?: boolean;
  indexQuery?: ServiceIndexQuery;
  indexFailure?: boolean;
}

/** Identity context for a denied request. */
function requestIdentity(event: SandboxEvent, verdict: ChipRequest['verdict']): string | null {
  if (verdict !== 'denied') return null;
  const auth = (event as { auth?: unknown }).auth;
  if (auth === null || auth === undefined) return 'signed out';
  const uid = (auth as { uid?: unknown }).uid;
  return typeof uid === 'string' ? uid : 'Signed-in user';
}

/** Shared retention ceiling; the view pages independently. */
export const TRAFFIC_TAIL = OBSERVATION_HISTORY_LIMITS.maxEvents;

/** How long a failure stays the reason the panel opens on Traffic. */
export const RECENT_FAILURE_MS = 60_000;

/** The spellings a denied code arrives under across the services. */
export function isPermissionDeniedCode(code: string | undefined): boolean {
  if (code === undefined) return false;
  const normalized = code.toLowerCase();
  return normalized === 'permission_denied'
    || normalized === 'permission-denied'
    || normalized === 'auth/permission-denied';
}

/**
 * The request a sandbox event stands for, or `null` when it is not one.
 *
 * A listener attach is a request: it is read once at the server and can be
 * denied like any other. The canonical projection covers the request and
 * operation families, so the attach phase is what this module adds itself — in
 * both the canonical `listener` shape and Firestore's older `listener_attach`
 * one, because a served page can be emitting either.
 */
export function chipRequestFromEvent(event: SandboxEvent): ChipRequest | null {
  const record = toOperationRecord(event);
  if (record !== null) {
    const observation = record.observation;
    if (observation?.ai) {
      const request = aiTrafficRequest({ id: record.id, startedAt: observation.startedAt,
        at: observation.endedAt ?? event.at, second: Math.floor(event.at / 1000),
        method: record.method, status: observation.status, detail: observation.ai, response: observation.response });
      return { ...request, identity: record.auth?.uid ?? null };
    }
    let verdict: ChipRequest['verdict'] = 'ok';
    if (record.rules.kind === 'evaluated' && record.rules.verdict === 'deny') verdict = 'denied';
    if (record.rules.kind === 'not-evaluated' && record.rules.reason === 'unsupported') verdict = 'unsupported';
    if (record.rules.kind === 'not-evaluated' && record.rules.reason === 'runtime-error') verdict = 'error';
    if (record.result === 'error') verdict = 'error';
    const request: ChipRequest = {
      id: record.id, at: record.at, service: record.service,
      method: record.eventKind === 'listener' ? 'listen' : record.method,
      path: record.path ?? null, verdict,
      identity: requestIdentity(event, verdict),
    };
    if (record.rules.kind !== 'evaluated') request.rules = record.rules;
    if (event.kind === 'request' && event.rulesEvidence !== undefined) {
      request.rulesEvidence = structuredClone(event.rulesEvidence);
    }
    if (event.kind === 'request' && event.rulesEvidenceExpired) request.evidenceExpired = true;
    if (event.kind === 'request' && event.method === 'list') {
      const diagnostic = event.detail?.activityQuery as { scope?: { kind?: string }; filters?: unknown[]; orderBy?: unknown[] } | undefined;
      if (diagnostic && Array.isArray(diagnostic.filters) && Array.isArray(diagnostic.orderBy)) {
        request.indexQuery = captureIndexQuery(event.path, diagnostic.scope?.kind === 'collection-group', diagnostic.filters, diagnostic.orderBy);
      }
    }
    if (event.kind === 'operation' && event.service === 'rtdb' && event.path && event.request?.query) {
      const spec = event.request.query as Parameters<typeof captureDatabaseIndexQuery>[1];
      request.indexQuery = captureDatabaseIndexQuery(event.path, spec);
      request.indexFailure = event.detail?.failure === 'missing-index';
    }
    return request;
  }
  if (event.kind === 'listener' && event.phase === 'attach') {
    return {
      id: event.id,
      at: event.at,
      service: event.service,
      method: 'listen',
      path: event.target.path ?? null,
      verdict: event.result === 'deny' ? 'denied' : 'ok',
      identity: requestIdentity(event, event.result === 'deny' ? 'denied' : 'ok'),
    };
  }
  if (event.kind === 'listener_attach' || event.kind === 'listener_errored') {
    const failed = event.kind === 'listener_errored';
    return {
      id: event.id,
      at: event.at,
      service: 'firestore',
      method: 'listen',
      path: event.target.kind === 'doc' ? event.target.path : event.target.collection,
      verdict: failed
        ? isPermissionDeniedCode(event.error?.code) ? 'denied' : 'error'
        : 'ok',
      identity: requestIdentity(event, failed && isPermissionDeniedCode(event.error?.code) ? 'denied' : 'ok'),
    };
  }
  return null;
}

/**
 * Traffic's rows in reading order: a denial from the last minute is what the
 * developer opened the panel for, then any other fresh failure, then everything
 * newest first. Within each of the three the newest request is on top.
 */
export function orderChipRequests(
  requests: readonly ChipRequest[],
  now: number,
): ChipRequest[] {
  const rank = (request: ChipRequest): number => {
    if (request.verdict === 'ok' || now - request.at > RECENT_FAILURE_MS) return 2;
    return request.verdict === 'denied' ? 0 : 1;
  };
  return [...requests].sort((a, b) => rank(a) - rank(b) || b.at - a.at);
}

/** The bounded tail of requests the Traffic view reads. */
export interface TrafficFeed {
  /** Every remembered request, oldest first. */
  requests(): readonly ChipRequest[];
  /** `true` when a request failed within the last minute. */
  failedRecently(now?: number): boolean;
  omittedCount(): number;
  dispose(): void;
}

export interface TrafficFeedOptions {
  /**
   * The page's sandbox event source. The first delivery carries history, each
   * later delivery carries the events since the last one, which is the shape
   * the worker client's `subscribeEvents` and the in-page sandbox's history
   * plus `onEvent` both already have.
   */
  subscribeEvents: (callback: (events: readonly SandboxEvent[]) => void) => () => void;
  /** Called whenever the tail changed, for the panel's own rebuild. */
  onChange?: () => void;
  onRequest?: (request: ChipRequest, event: SandboxEvent) => void;
  /** How many rows to keep. */
  limit?: number;
  maxBytes?: number;
}

/** Start folding the page's sandbox events into Traffic's rows. */
export function createTrafficFeed(options: TrafficFeedOptions): TrafficFeed {
  const history = new EventHistory({
    maxEvents: options.limit ?? TRAFFIC_TAIL,
    maxBytes: options.maxBytes ?? OBSERVATION_HISTORY_LIMITS.maxBytes,
  });
  // Cache only the current retained snapshot. EventHistory replaces an event
  // when evidence expires, so its old projection leaves this cache as well.
  let projections = new Map<SandboxEvent, ChipRequest | null>();
  let cachedRequests: ChipRequest[] = [];
  let cacheSecond = -Infinity;
  const requests = (): ChipRequest[] => {
    const second = Math.floor(Date.now() / 1000);
    const isCurrentSnapshot = cacheSecond === second;
    if (isCurrentSnapshot) return cachedRequests;
    cacheSecond = second;
    const rows = new Map<string, ChipRequest>();
    const retainedProjections = new Map<SandboxEvent, ChipRequest | null>();
    for (const event of history.snapshot()) {
      const cached = projections.get(event);
      const needsProjection = cached === undefined;
      const request = needsProjection ? chipRequestFromEvent(event) : cached;
      retainedProjections.set(event, request);
      const hasRequest = request !== null;
      if (hasRequest) rows.set(request.id, request);
    }
    projections = retainedProjections;
    cachedRequests = [...rows.values()];
    return cachedRequests;
  };
  const unsubscribe = options.subscribeEvents(batch => {
    let changed = false;
    for (const event of batch) {
      const resetsSession = event.kind === 'session_boundary' && event.phase === 'reset';
      if (resetsSession) { history.clear(); changed = true; }
      const request = chipRequestFromEvent(event);
      if (request) {
        changed = true;
        history.append(event);
        options.onRequest?.(request, event);
      } else {
        const closesListener = event.kind === 'listener_detach' || event.kind === 'listener_errored'
          || (event.kind === 'listener' && (event.phase === 'detach' || event.phase === 'errored'));
        const tracksRetention = closesListener || event.kind === 'observation_gap';
        if (tracksRetention) { history.append(event); changed = true; }
      }
    }
    if (changed) {
      cacheSecond = -Infinity;
      options.onChange?.();
    }
  });
  return {
    requests() {
      return requests();
    },
    failedRecently(now = Date.now()) {
      return requests().some((request) => request.verdict !== 'ok' && now - request.at <= RECENT_FAILURE_MS);
    },
    omittedCount() {
      const gap = history.snapshot().find(event => event.kind === 'observation_gap');
      return gap?.kind === 'observation_gap' ? gap.omittedCount : 0;
    },
    dispose() {
      unsubscribe();
      history.clear();
      projections.clear();
      cachedRequests = [];
      cacheSecond = -Infinity;
    },
  };
}

export function aiTrafficRequest(request: AiRequestObservation): ChipRequest {
  return { id: request.id, at: request.startedAt ?? request.at, service: "ai", method: request.method, path: request.detail.requestedModel, verdict: request.status === "failed" ? "error" : "ok", identity: null, aiRequest: request };
}

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
import type { SandboxEvent } from 'pyric/sandbox';
import { toOperationRecord } from 'pyric/sandbox';

/** One line of the Traffic view. */
export interface ChipRequest {
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
  verdict: 'ok' | 'denied' | 'error';
  /** Plain words for a denial: who the request ran as. `null` when it went through. */
  reason: string | null;
}

/** The denial's reason in the words a developer acts on: the identity that was denied. */
function denialReason(event: SandboxEvent, verdict: 'ok' | 'denied' | 'error'): string | null {
  if (verdict !== 'denied') return null;
  const auth = (event as { auth?: unknown }).auth;
  if (auth === null || auth === undefined) return 'signed out';
  const uid = (auth as { uid?: unknown }).uid;
  return typeof uid === 'string' ? `denied for ${uid}` : 'denied for this user';
}

/** How many rows the tail keeps. The view shows eight of them. */
export const TRAFFIC_TAIL = 64;

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
    return {
      id: record.id,
      at: record.at,
      service: record.service,
      method: record.eventKind === 'listener' ? 'listen' : record.method,
      path: record.path ?? null,
      verdict: record.rules.kind === 'evaluated' && record.rules.verdict === 'deny' ? 'denied' : 'ok',
      reason: denialReason(event, record.rules.kind === 'evaluated' && record.rules.verdict === 'deny' ? 'denied' : 'ok'),
    };
  }
  if (event.kind === 'listener' && event.phase === 'attach') {
    return {
      id: event.id,
      at: event.at,
      service: event.service,
      method: 'listen',
      path: event.target.path ?? null,
      verdict: event.result === 'deny' ? 'denied' : 'ok',
      reason: denialReason(event, event.result === 'deny' ? 'denied' : 'ok'),
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
      reason: denialReason(event, failed && isPermissionDeniedCode(event.error?.code) ? 'denied' : 'ok'),
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
  /** How many rows to keep. */
  limit?: number;
}

/** Start folding the page's sandbox events into Traffic's rows. */
export function createTrafficFeed(options: TrafficFeedOptions): TrafficFeed {
  const limit = options.limit ?? TRAFFIC_TAIL;
  let tail: ChipRequest[] = [];
  const unsubscribe = options.subscribeEvents((batch) => {
    let added = false;
    for (const event of batch) {
      const request = chipRequestFromEvent(event);
      if (request === null) continue;
      tail.push(request);
      added = true;
    }
    if (!added) return;
    if (tail.length > limit) tail = tail.slice(tail.length - limit);
    options.onChange?.();
  });
  return {
    requests() {
      return tail;
    },
    failedRecently(now = Date.now()) {
      return tail.some((request) => request.verdict !== 'ok' && now - request.at <= RECENT_FAILURE_MS);
    },
    dispose() {
      unsubscribe();
      tail = [];
    },
  };
}

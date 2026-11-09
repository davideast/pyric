/**
 * Shared path canonicalization, target classification, and delivery-summary
 * readers for observed live Firestore and Realtime Database listeners.
 *
 * Both the worker host (`@pyric/cli`) and Studio (`@pyric/studio`) consume
 * these helpers through `pyric/sandbox/internal` so path trimming, single-doc
 * detection, live delivery correlation, and `detail.delivery` decoding have a
 * single implementation across planes.
 */
import type {
  ObservedCall,
  ObservedDeliverySummary,
  ObservedListener,
  ObservedQuery,
} from '../types/observed-call.js';
import type {
  SandboxEvent,
  SandboxListenerEvent,
  SandboxOperationEvent,
} from '../types/events.js';

/** Maximum number of canonical paths persisted on one `ObservedDeliverySummary`. */
export const MAX_OBSERVED_DELIVERY_PATHS = 64;

/** The RTDB event each listener export subscribes to, as sandbox listener targets name it. */
const RTDB_LISTENER_KINDS: ReadonlyMap<string, string> = new Map([
  ['onChildAdded', 'child_added'],
  ['onChildChanged', 'child_changed'],
  ['onChildRemoved', 'child_removed'],
  ['onChildMoved', 'child_moved'],
]);

/** Strip leading and trailing slashes from an observed Firestore or RTDB path. */
export function trimObservedPath(path: string): string {
  return path.replace(/^\/+|\/+$/g, '');
}

/**
 * Whether `path` names a single Firestore document (a non-empty path with an
 * even number of non-empty slash-separated segments).
 */
export function isFirestoreDocumentPath(path: string): boolean {
  const trimmed = trimObservedPath(path);
  if (trimmed === '') return false;
  const segments = trimmed.split('/');
  if (segments.includes('**')) return false;
  return segments.length % 2 === 0 && segments.every((segment) => segment.length > 0);
}

/**
 * Build the canonical `SandboxListenerEvent['target']` for an observed attach
 * or detach record across Firestore and Realtime Database.
 */
export function observedListenerTarget(
  call: Pick<ObservedCall, 'service' | 'method'>,
  listener: Pick<ObservedListener, 'target'>,
  query?: ObservedQuery,
): SandboxListenerEvent['target'] {
  const path = listener.target;
  if (call.service === 'rtdb') {
    return { kind: RTDB_LISTENER_KINDS.get(call.method) ?? 'value', path };
  }
  const kind = isFirestoreDocumentPath(path) ? 'doc' : 'query';
  return query === undefined ? { kind, path } : { kind, path, query };
}

/** Read a non-empty `listenerId` from an operation event's `detail` bag. */
export function observedDetailListenerId(detail: unknown): string | undefined {
  if (detail === null || typeof detail !== 'object' || Array.isArray(detail)) return undefined;
  const listenerId = (detail as { listenerId?: unknown }).listenerId;
  return typeof listenerId === 'string' && listenerId.length > 0 ? listenerId : undefined;
}

/**
 * Return the scoped `listenerId` when `event` is a successful observed live
 * Firestore or Realtime Database listener delivery, or `undefined` otherwise.
 */
export function liveListenerIdOf(event: SandboxEvent): string | undefined {
  if (event.kind !== 'operation' || event.result !== 'allow') return undefined;
  const service = event.service ?? 'firestore';
  if (service !== 'firestore' && service !== 'rtdb') return undefined;
  return observedDetailListenerId(event.detail);
}

/** Whether `event` is a successful observed live listener callback delivery. */
export function isLiveListenerDeliveryEvent(
  event: SandboxEvent,
): event is SandboxOperationEvent {
  return liveListenerIdOf(event) !== undefined;
}

function isStringList(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string');
}

/**
 * Read a validated `ObservedDeliverySummary` from `event.detail.delivery`, or
 * `undefined` when the event carries none or its shape is malformed.
 */
export function observedDeliveryOf(
  event: Pick<SandboxOperationEvent, 'detail'>,
): ObservedDeliverySummary | undefined {
  const raw = event.detail?.delivery;
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const candidate = raw as Record<string, unknown>;
  const mode = candidate.mode;
  if (mode !== 'snapshot' && mode !== 'delta') return undefined;
  const size = candidate.size;
  if (typeof size !== 'number' || !Number.isInteger(size) || size < 0) return undefined;
  const paths = candidate.paths;
  if (!isStringList(paths)) return undefined;
  const removed = candidate.removedPaths;
  if (removed !== undefined && !isStringList(removed)) return undefined;
  if (removed === undefined) return { mode, size, paths };
  return { mode, size, paths, removedPaths: removed };
}

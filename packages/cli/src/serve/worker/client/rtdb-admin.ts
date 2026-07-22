/** Admin-lens RTDB operations used by Studio's data viewer. */
import type { InboundMessage } from '../protocol.js';
import {
  closeSubscription,
  nextId,
  nextSubId,
  openSnapshotSubscription,
  rpc,
  stampIssuer,
} from './core.js';
import type { ClientDb, ClientRtdb, Unsubscribe } from './handles.js';
import { normalizeRtdbPath } from './rtdb-references.js';

export async function adminReadRtdbState(db: ClientDb | ClientRtdb): Promise<unknown> {
  return rpc(db.port, { t: 'op', id: nextId(), method: 'rtdb.adminSnapshot' });
}

export async function adminSetRtdbValue(
  db: ClientDb | ClientRtdb,
  path: string,
  value: unknown,
): Promise<void> {
  await rpc(db.port, {
    t: 'op', id: nextId(), method: 'rtdb.set', path, value, actAs: { mode: 'admin' },
  });
}

export async function adminUpdateRtdbValue(
  db: ClientDb | ClientRtdb,
  path: string,
  values: Record<string, unknown>,
): Promise<void> {
  await rpc(db.port, {
    t: 'op', id: nextId(), method: 'rtdb.update', path, values, actAs: { mode: 'admin' },
  });
}

export async function adminDeleteRtdbValue(
  db: ClientDb | ClientRtdb,
  path: string,
): Promise<void> {
  await rpc(db.port, {
    t: 'op', id: nextId(), method: 'rtdb.remove', path, actAs: { mode: 'admin' },
  });
}

/** Subscribe with an explicit admin lens so Studio stays rules-independent. */
export function adminSubscribeRtdbValue(
  db: ClientDb | ClientRtdb,
  path: string,
  next: (value: unknown) => void,
  error?: (err: unknown) => void,
): Unsubscribe {
  const subId = nextSubId();
  const opened = openSnapshotSubscription(
    db.port,
    subId,
    {
      port: db.port,
      next: (wire) => next((wire as { value?: unknown } | null)?.value ?? null),
      error,
    },
    stampIssuer({
      t: 'sub',
      subId,
      target: { service: 'rtdb', path: normalizeRtdbPath(path) },
      actAs: { mode: 'admin' },
    } satisfies InboundMessage),
  );
  if (!opened && error) {
    queueMicrotask(() => error(new Error('FIREBASE FATAL ERROR: Database has been deleted.')));
  }
  return () => closeSubscription(db.port, subId);
}

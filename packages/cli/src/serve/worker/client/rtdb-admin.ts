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

/** The protocol's `instance` field: the explicit name, else the handle's instance. */
function instanceOf(db: ClientDb | ClientRtdb, instance: string | undefined): { instance: string | undefined } {
  return { instance: instance ?? ('instance' in db ? db.instance?.name : undefined) };
}

export async function adminReadRtdbState(db: ClientDb | ClientRtdb, instance?: string): Promise<unknown> {
  return rpc(db.port, { t: 'op', id: nextId(), method: 'rtdb.adminSnapshot', ...instanceOf(db, instance) });
}

export async function adminSetRtdbValue(
  db: ClientDb | ClientRtdb,
  path: string,
  value: unknown,
  instance?: string,
): Promise<void> {
  await rpc(db.port, {
    t: 'op', id: nextId(), method: 'rtdb.set', path, value, actAs: { mode: 'admin' }, ...instanceOf(db, instance),
  });
}

export async function adminUpdateRtdbValue(
  db: ClientDb | ClientRtdb,
  path: string,
  values: Record<string, unknown>,
  instance?: string,
): Promise<void> {
  await rpc(db.port, {
    t: 'op', id: nextId(), method: 'rtdb.update', path, values, actAs: { mode: 'admin' }, ...instanceOf(db, instance),
  });
}

export async function adminDeleteRtdbValue(
  db: ClientDb | ClientRtdb,
  path: string,
  instance?: string,
): Promise<void> {
  await rpc(db.port, {
    t: 'op', id: nextId(), method: 'rtdb.remove', path, actAs: { mode: 'admin' }, ...instanceOf(db, instance),
  });
}

/** Subscribe with an explicit admin lens so Studio stays rules-independent. */
export function adminSubscribeRtdbValue(
  db: ClientDb | ClientRtdb,
  path: string,
  next: (value: unknown) => void,
  error?: (err: unknown) => void,
  instance?: string,
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
      target: { service: 'rtdb', ...instanceOf(db, instance), path: normalizeRtdbPath(path) },
      actAs: { mode: 'admin' },
    } satisfies InboundMessage),
  );
  if (!opened && error) {
    queueMicrotask(() => error(new Error('FIREBASE FATAL ERROR: Database has been deleted.')));
  }
  return () => closeSubscription(db.port, subId);
}

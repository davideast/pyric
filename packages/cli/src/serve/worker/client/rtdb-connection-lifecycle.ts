/** Per-port RTDB disconnect registration and explicit connection lifecycle. */
import { dataRpc, nextId } from './core.js';
import type { ClientRtdb, RtdbRefHandle } from './handles.js';

export class RtdbOnDisconnect {
  constructor(
    private readonly ref: RtdbRefHandle,
    private readonly path = ref.path,
  ) {}

  cancel(): Promise<void> {
    return dataRpc(this.ref.port, {
      t: 'op', id: nextId(), method: 'rtdb.onDisconnectCancel', path: this.path,
    }).then(() => undefined);
  }

  remove(): Promise<void> {
    return dataRpc(this.ref.port, {
      t: 'op', id: nextId(), method: 'rtdb.onDisconnectRemove', path: this.path,
    }).then(() => undefined);
  }

  set(value: unknown): Promise<void> {
    return dataRpc(this.ref.port, {
      t: 'op', id: nextId(), method: 'rtdb.onDisconnectSet', path: this.path, value,
    }).then(() => undefined);
  }

  setWithPriority(value: unknown, priority: string | number | null): Promise<void> {
    return dataRpc(this.ref.port, {
      t: 'op', id: nextId(), method: 'rtdb.onDisconnectSet', path: this.path, value, priority,
    }).then(() => undefined);
  }

  update(values: Record<string, unknown>): Promise<void> {
    return dataRpc(this.ref.port, {
      t: 'op', id: nextId(), method: 'rtdb.onDisconnectUpdate', path: this.path, values,
    }).then(() => undefined);
  }
}

export function rtdbOnDisconnect(ref: RtdbRefHandle): RtdbOnDisconnect {
  return new RtdbOnDisconnect(ref);
}

export function rtdbGoOffline(db: ClientRtdb): void {
  void dataRpc(db.port, { t: 'op', id: nextId(), method: 'rtdb.goOffline' }).catch(() => undefined);
}

export function rtdbGoOnline(db: ClientRtdb): void {
  void dataRpc(db.port, { t: 'op', id: nextId(), method: 'rtdb.goOnline' }).catch(() => undefined);
}

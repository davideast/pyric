/** Per-port RTDB disconnect registration and explicit connection lifecycle. */
import { dataRpc, nextId } from './core.js';
import type { ClientRtdb, RtdbRefHandle } from './handles.js';

export class RtdbOnDisconnect {
  constructor(
    private readonly _repo: RtdbRefHandle,
    private readonly _path = _repo.path,
  ) {}

  cancel(): Promise<void> {
    return dataRpc(this._repo.port, {
      t: 'op', id: nextId(), method: 'rtdb.onDisconnectCancel', path: this._path,
    }).then(() => undefined);
  }

  remove(): Promise<void> {
    return dataRpc(this._repo.port, {
      t: 'op', id: nextId(), method: 'rtdb.onDisconnectRemove', path: this._path,
    }).then(() => undefined);
  }

  set(value: unknown): Promise<void> {
    return dataRpc(this._repo.port, {
      t: 'op', id: nextId(), method: 'rtdb.onDisconnectSet', path: this._path, value,
    }).then(() => undefined);
  }

  setWithPriority(value: unknown, priority: string | number | null): Promise<void> {
    return dataRpc(this._repo.port, {
      t: 'op', id: nextId(), method: 'rtdb.onDisconnectSet', path: this._path, value, priority,
    }).then(() => undefined);
  }

  update(values: Record<string, unknown>): Promise<void> {
    return dataRpc(this._repo.port, {
      t: 'op', id: nextId(), method: 'rtdb.onDisconnectUpdate', path: this._path, values,
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

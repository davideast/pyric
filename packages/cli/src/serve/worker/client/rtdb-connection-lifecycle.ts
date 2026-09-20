/** Per-port RTDB disconnect registration and explicit connection lifecycle. */
import { dataRpc, nextId } from './core.js';
import type { ClientPort, ClientRtdb, RtdbRefHandle } from './handles.js';

interface RtdbConnectionState {
  networkEnabled: boolean;
  listeners: Set<() => void>;
}

const connections = new WeakMap<ClientPort, RtdbConnectionState>();

function connectionFor(port: ClientPort): RtdbConnectionState {
  const existing = connections.get(port);
  const hasConnection = existing !== undefined;
  if (hasConnection) return existing;
  const connection = { networkEnabled: true, listeners: new Set<() => void>() };
  connections.set(port, connection);
  return connection;
}

function setNetworkEnabled(port: ClientPort, networkEnabled: boolean): void {
  const connection = connectionFor(port);
  connection.networkEnabled = networkEnabled;
  for (const listener of [...connection.listeners]) listener();
}

/** RTDB is connected only when its transport and the app's network control allow it. */
export function observeRtdbConnection(port: ClientPort, next: (connected: boolean) => void): () => void {
  const connection = connectionFor(port);
  const isLocalTransport = port.observeConnection === undefined;
  let networkConnected = isLocalTransport;
  let previous: boolean | undefined;
  let closed = false;
  const update = (): void => {
    if (closed) return;
    const connected = networkConnected && connection.networkEnabled;
    const isUnchanged = previous === connected;
    if (isUnchanged) return;
    previous = connected;
    next(connected);
  };
  connection.listeners.add(update);
  const stopObserving = port.observeConnection?.((connected) => {
    networkConnected = connected;
    update();
  });
  if (isLocalTransport) queueMicrotask(update);
  return () => {
    closed = true;
    connection.listeners.delete(update);
    stopObserving?.();
  };
}

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
  setNetworkEnabled(db.port, false);
  void dataRpc(db.port, { t: 'op', id: nextId(), method: 'rtdb.goOffline' }).catch(() => undefined);
}

export function rtdbGoOnline(db: ClientRtdb): void {
  setNetworkEnabled(db.port, true);
  void dataRpc(db.port, { t: 'op', id: nextId(), method: 'rtdb.goOnline' }).catch(() => undefined);
}

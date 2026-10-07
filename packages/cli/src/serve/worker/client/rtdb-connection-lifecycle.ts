/** Per-port RTDB disconnect registration and explicit connection lifecycle. */
import { validateWritablePath } from 'pyric/database/internal';
import { nextId } from './core.js';
import type { ClientPort, ClientRtdb, ClientRtdbInstance, RtdbRefHandle } from './handles.js';
import { rtdbRpc } from './rtdb-references.js';

interface RtdbConnectionState {
  networkEnabled: boolean;
  listeners: Set<() => void>;
}

/** As in production, each database instance is its own connection. */
type InstanceHandle = { readonly port: ClientPort; readonly instance?: ClientRtdbInstance };

const connections = new WeakMap<ClientPort, Map<string | undefined, RtdbConnectionState>>();

function connectionFor(handle: InstanceHandle): RtdbConnectionState {
  let instances = connections.get(handle.port);
  if (instances === undefined) {
    instances = new Map();
    connections.set(handle.port, instances);
  }
  const name = handle.instance?.name;
  const existing = instances.get(name);
  const hasConnection = existing !== undefined;
  if (hasConnection) return existing;
  const connection = { networkEnabled: true, listeners: new Set<() => void>() };
  instances.set(name, connection);
  return connection;
}

function setNetworkEnabled(handle: InstanceHandle, networkEnabled: boolean): void {
  const connection = connectionFor(handle);
  connection.networkEnabled = networkEnabled;
  for (const listener of [...connection.listeners]) listener();
}

/** RTDB is connected only when its transport and the app's network control allow it. */
export function observeRtdbConnection(handle: InstanceHandle, next: (connected: boolean) => void): () => void {
  const port = handle.port;
  const connection = connectionFor(handle);
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
    return rtdbRpc(this._repo, {
      t: 'op', id: nextId(), method: 'rtdb.onDisconnectCancel', path: this._path,
    }).then(() => undefined);
  }

  remove(): Promise<void> {
    validateWritablePath('OnDisconnect.remove', this._path);
    return rtdbRpc(this._repo, {
      t: 'op', id: nextId(), method: 'rtdb.onDisconnectRemove', path: this._path,
    }).then(() => undefined);
  }

  set(value: unknown): Promise<void> {
    validateWritablePath('OnDisconnect.set', this._path);
    return rtdbRpc(this._repo, {
      t: 'op', id: nextId(), method: 'rtdb.onDisconnectSet', path: this._path, value,
    }).then(() => undefined);
  }

  setWithPriority(value: unknown, priority: string | number | null): Promise<void> {
    validateWritablePath('OnDisconnect.setWithPriority', this._path);
    return rtdbRpc(this._repo, {
      t: 'op', id: nextId(), method: 'rtdb.onDisconnectSet', path: this._path, value, priority,
    }).then(() => undefined);
  }

  update(values: Record<string, unknown>): Promise<void> {
    validateWritablePath('OnDisconnect.update', this._path);
    return rtdbRpc(this._repo, {
      t: 'op', id: nextId(), method: 'rtdb.onDisconnectUpdate', path: this._path, values,
    }).then(() => undefined);
  }
}

export function rtdbOnDisconnect(ref: RtdbRefHandle): RtdbOnDisconnect {
  return new RtdbOnDisconnect(ref);
}

export function rtdbGoOffline(db: ClientRtdb): void {
  setNetworkEnabled(db, false);
  void rtdbRpc(db, { t: 'op', id: nextId(), method: 'rtdb.goOffline' }).catch(() => undefined);
}

export function rtdbGoOnline(db: ClientRtdb): void {
  setNetworkEnabled(db, true);
  void rtdbRpc(db, { t: 'op', id: nextId(), method: 'rtdb.goOnline' }).catch(() => undefined);
}

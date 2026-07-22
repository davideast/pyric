/** Per-service listener registration identity for Firebase-compatible `off()`. */

export interface ListenerRegistration {
  unsubscribe(): void;
}

export class ListenerRegistry {
  private readonly byTarget = new WeakMap<object, Map<string, ListenerRegistration[]>>();
  private readonly callbackIds = new WeakMap<object, number>();
  private nextCallbackId = 1;

  add(
    target: object,
    path: string,
    event: string,
    callback: object,
    registration: ListenerRegistration,
    scope = 'default',
  ): void {
    const map = this.mapFor(target);
    const key = this.key(path, scope, event, callback);
    const registrations = map.get(key) ?? [];
    registrations.push(registration);
    map.set(key, registrations);
  }

  removeExact(
    target: object,
    path: string,
    event: string,
    callback: object,
    registration: ListenerRegistration,
    scope = 'default',
  ): void {
    const map = this.byTarget.get(target);
    const key = this.key(path, scope, event, callback);
    const registrations = map?.get(key);
    if (!map || !registrations) return;
    const index = registrations.indexOf(registration);
    if (index >= 0) registrations.splice(index, 1);
    if (registrations.length === 0) map.delete(key);
  }

  takeFirst(
    target: object,
    path: string,
    event: string,
    callback: object,
    scope?: string,
  ): ListenerRegistration | undefined {
    const map = this.byTarget.get(target);
    if (!map) return undefined;
    const callbackId = this.callbackId(callback);
    const separator = String.fromCharCode(0);
    for (const [key, registrations] of map) {
      const [storedPath, storedScope, storedEvent, storedCallbackId] = key.split(separator);
      if (storedPath !== path || storedEvent !== event
        || storedCallbackId !== String(callbackId)
        || (scope !== undefined && storedScope !== scope)) continue;
      const registration = registrations.shift();
      if (registrations.length === 0) map.delete(key);
      return registration;
    }
    return undefined;
  }

  takeMatching(
    target: object,
    path: string,
    event?: string,
    scope?: string,
  ): ListenerRegistration[] {
    const map = this.byTarget.get(target);
    if (!map) return [];
    const separator = String.fromCharCode(0);
    const matches: ListenerRegistration[] = [];
    for (const [key, registrations] of [...map]) {
      const [storedPath, storedScope, storedEvent] = key.split(separator);
      if (storedPath !== path || (scope !== undefined && storedScope !== scope)
        || (event !== undefined && storedEvent !== event)) continue;
      map.delete(key);
      matches.push(...registrations);
    }
    return matches;
  }

  private mapFor(target: object): Map<string, ListenerRegistration[]> {
    let map = this.byTarget.get(target);
    if (!map) {
      map = new Map();
      this.byTarget.set(target, map);
    }
    return map;
  }

  private key(path: string, scope: string, event: string, callback: object): string {
    const id = this.callbackId(callback);
    return `${path}${String.fromCharCode(0)}${scope}${String.fromCharCode(0)}${event}${String.fromCharCode(0)}${id}`;
  }

  private callbackId(callback: object): number {
    let id = this.callbackIds.get(callback);
    if (id === undefined) {
      id = this.nextCallbackId++;
      this.callbackIds.set(callback, id);
    }
    return id;
  }
}

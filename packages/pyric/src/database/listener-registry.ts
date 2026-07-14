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
  ): void {
    const map = this.mapFor(target);
    const key = this.key(path, event, callback);
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
  ): void {
    const map = this.byTarget.get(target);
    const key = this.key(path, event, callback);
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
  ): ListenerRegistration | undefined {
    const map = this.byTarget.get(target);
    const key = this.key(path, event, callback);
    const registrations = map?.get(key);
    const registration = registrations?.shift();
    if (registrations?.length === 0) map?.delete(key);
    return registration;
  }

  takeMatching(target: object, path: string, event?: string): ListenerRegistration[] {
    const map = this.byTarget.get(target);
    if (!map) return [];
    const separator = String.fromCharCode(0);
    const prefix = event === undefined
      ? `${path}${separator}`
      : `${path}${separator}${event}${separator}`;
    const matches: ListenerRegistration[] = [];
    for (const [key, registrations] of [...map]) {
      if (!key.startsWith(prefix)) continue;
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

  private key(path: string, event: string, callback: object): string {
    let id = this.callbackIds.get(callback);
    if (id === undefined) {
      id = this.nextCallbackId++;
      this.callbackIds.set(callback, id);
    }
    return `${path}${String.fromCharCode(0)}${event}${String.fromCharCode(0)}${id}`;
  }
}

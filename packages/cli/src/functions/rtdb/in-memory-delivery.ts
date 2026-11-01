import type { RtdbTriggerDelivery } from './delivery.js';

function canonicalPath(path: string): string {
  const normalized = path.split('/').filter(Boolean).join('/');
  return normalized ? `/${normalized}` : '/';
}

/** Deterministic test adapter for the snapshot-delivery seam. */
export class InMemoryRtdbTriggerDelivery implements RtdbTriggerDelivery {
  readonly #values = new Map<string, unknown>();
  readonly #listeners = new Map<string, Set<(value: unknown) => void>>();

  seed(path: string, value: unknown): void {
    this.#values.set(canonicalPath(path), structuredClone(value));
  }

  emit(path: string, value: unknown): void {
    const key = canonicalPath(path);
    const snapshot = structuredClone(value);
    this.#values.set(key, snapshot);
    for (const listener of this.#listeners.get(key) ?? []) {
      listener(structuredClone(snapshot));
    }
  }

  subscribe(path: string, listener: (value: unknown) => void): () => void {
    const key = canonicalPath(path);
    let listeners = this.#listeners.get(key);
    if (!listeners) {
      listeners = new Set();
      this.#listeners.set(key, listeners);
    }
    listeners.add(listener);
    listener(structuredClone(this.#values.get(key) ?? null));
    return () => {
      listeners?.delete(listener);
      if (listeners?.size === 0) this.#listeners.delete(key);
    };
  }
}

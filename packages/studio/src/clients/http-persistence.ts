/**
 * `httpPersistence(baseUrl)`: a {@link PersistenceBackend} (sandbox durable
 * state) over the pyric devr's existing `--persist` channel, `/__pyric/state`.
 *
 * The {@link PersistenceBackend} contract is a generic `key → blob` store, but
 * the server's state route is SECTION-keyed (`firestore` | `auth`) and guarded
 * by a single-writer lock (`x-pyric-writer`). The sandbox persistence controller
 * stores its whole blob under one key, so we map:
 *
 *     key === 'auth' (or contains 'auth')  → section=auth
 *     everything else                       → section=firestore
 *
 * That's enough for the sandbox controller (it uses a stable key per store).
 *
 * TODO(T3): the section mapping is a pragmatic bridge to the EXISTING persist
 * route. A cleaner long-term shape is a dedicated key/value studio-state route
 * (`/__pyric/studio/state?key=`) so arbitrary keys round-trip without the
 * firestore/auth section coupling. Until then, callers needing keys outside
 * {firestore, auth} should use {@link createMemoryBackend}.
 */
import type { PersistenceBackend } from '../ports.js';
import { bundleRecords, parseBundle } from 'pyric/sandbox';

function joinUrl(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/$/, '')}${path}`;
}

function sectionFor(key: string): 'firestore' | 'auth' {
  return /auth/i.test(key) ? 'auth' : 'firestore';
}

export function httpPersistence(baseUrl: string): PersistenceBackend {
  const base = baseUrl;
  // A stable writer id per backend instance, so this client claims/holds the
  // single-writer lock the server enforces on /__pyric/state writes.
  const writerId = `studio-${Math.random().toString(36).slice(2)}`;
  const headers = { 'content-type': 'application/json', 'x-pyric-writer': writerId };

  // Per-section cache of the parsed v3 bundle, so a restore (list + per-record
  // get) costs one fetch per section, not one fetch per record.
  const cache = new Map<string, Map<string, unknown>>();
  const sectionUrl = (key: string): string =>
    joinUrl(base, `/__pyric/state?section=${sectionFor(key)}`);

  const load = async (key: string): Promise<Map<string, unknown>> => {
    const section = sectionFor(key);
    const cached = cache.get(section);
    if (cached) return cached;
    const res = await fetch(sectionUrl(key));
    let map = new Map<string, unknown>();
    if (res.ok) {
      const value = await res.text();
      if (value && value !== 'null') map = parseBundle(value);
    } else if (res.status !== 404) {
      throw new Error(`persistence.read(${key}) → ${res.status}`);
    }
    cache.set(section, map);
    return map;
  };

  const save = async (key: string, map: Map<string, unknown>): Promise<void> => {
    const res = await fetch(sectionUrl(key), {
      method: 'POST',
      headers,
      body: bundleRecords(map),
    });
    if (res.status === 423) {
      throw new Error(
        'persistence.write blocked, another tab holds the persist writer lock',
      );
    }
    if (!res.ok) throw new Error(`persistence.write(${key}) → ${res.status}`);
  };

  return {
    async getRecord(key, recordId) {
      return (await load(key)).get(recordId) ?? null;
    },
    async listRecords(key) {
      return [...(await load(key)).keys()];
    },
    async putRecords(key, records) {
      const map = await load(key);
      for (const [id, rec] of records) map.set(id, rec);
      await save(key, map);
    },
    async deleteRecords(key, recordIds) {
      const map = await load(key);
      for (const id of recordIds) map.delete(id);
      await save(key, map);
    },
    async clear(key) {
      cache.set(sectionFor(key), new Map());
      const res = await fetch(sectionUrl(key), {
        method: 'POST',
        headers,
        body: 'null',
      });
      if (!res.ok && res.status !== 423) {
        throw new Error(`persistence.clear(${key}) → ${res.status}`);
      }
    },
  };
}

/**
 * Session persistence and pause/resume helpers for `firestore_discover_paths`.
 */
import type {
  CrawlOptions,
  DiscoveredCollection,
  FullCrawlResult,
  PersistedCrawlState,
  PersistedDiscoveredCollection,
} from './crawler-types.js';
import type {
  CrawlerCollectionRef,
  CrawlerDocumentRef,
  CrawlerFirestore,
} from './firestore-source.js';
import type { SessionError, SessionStore } from './session.js';
import type { CollectionSchema, DiscoverEvent } from './types.js';

export function serializeDiscovered(
  map: Map<string, DiscoveredCollection>,
): Record<string, PersistedDiscoveredCollection> {
  const out: Record<string, PersistedDiscoveredCollection> = {};
  for (const [tpl, d] of map) {
    Object.defineProperty(out, tpl, {
      value: {
        templatePath: d.templatePath,
        depth: d.depth,
        examplePath: d.examplePath,
        refPaths: d.refs.map((r) => r.path),
        docRefPaths: d.docRefs.map((r) => r.path),
      },
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  return out;
}

export function hydrateDiscovered(
  record: Record<string, PersistedDiscoveredCollection>,
  db: CrawlerFirestore,
): Map<string, DiscoveredCollection> {
  const map = new Map<string, DiscoveredCollection>();
  for (const [tpl, p] of Object.entries(record)) {
    map.set(tpl, {
      templatePath: p.templatePath,
      depth: p.depth,
      examplePath: p.examplePath,
      refs: p.refPaths.map((rp) => requireCollection(db, rp)),
      docRefs: p.docRefPaths.map((dp) => requireDoc(db, dp)),
    });
  }
  return map;
}

export function requireCollection(db: CrawlerFirestore, path: string): CrawlerCollectionRef {
  if (typeof db.collection !== 'function') {
    throw new Error(
      'Cannot resume crawl: db.collection(path) is required to reconstruct refs ' +
        'but the supplied Firestore does not implement it.',
    );
  }
  return db.collection(path);
}

function requireDoc(db: CrawlerFirestore, path: string): CrawlerDocumentRef {
  if (typeof db.doc !== 'function') {
    throw new Error(
      'Cannot resume crawl: db.doc(path) is required to reconstruct refs ' +
        'but the supplied Firestore does not implement it.',
    );
  }
  return db.doc(path);
}

/**
 * Returns `{ bytes, serialized }` when `sessions` is provided and `state`
 * reaches `maxBatchBytes`, else `null`.
 */
export function checkPause(
  state: PersistedCrawlState,
  sessions: SessionStore<PersistedCrawlState> | undefined,
  maxBatchBytes: number,
): { bytes: number; serialized: string } | null {
  if (sessions === undefined) return null;
  const serialized = JSON.stringify(state);
  const bytes = serialized.length;
  if (bytes < maxBatchBytes) return null;
  return { bytes, serialized };
}

export function pauseAndPersist(
  pause: { bytes: number; serialized: string },
  state: PersistedCrawlState,
  events: DiscoverEvent[],
  discovered: Map<string, DiscoveredCollection>,
  sessions: SessionStore<PersistedCrawlState>,
  options: CrawlOptions,
): FullCrawlResult {
  let token: string;
  if (options.continuation !== undefined) {
    const r = sessions.update(options.continuation, state, pause.bytes);
    if (!r.ok) {
      events.push(sessionErrorToEvent(r.error));
      return emptyResult(events);
    }
    token = r.value.token;
  } else {
    const r = sessions.create(state, pause.bytes);
    if (!r.ok) {
      events.push(sessionErrorToEvent(r.error));
      return emptyResult(events);
    }
    token = r.value.token;
  }

  const finalizedSchemas = new Map<string, CollectionSchema>();
  for (const [k, v] of Object.entries(state.finalizedSchemas)) {
    finalizedSchemas.set(k, v);
  }

  return {
    events,
    discovered,
    listOps: state.listOps,
    readOps: state.readOps,
    finalizedSchemas,
    continuation: token,
    complete: false,
  };
}

export function sessionErrorToEvent(err: SessionError): DiscoverEvent {
  return {
    kind: 'error',
    templatePath: '',
    code: err.code,
    message: `${err.message} (recoveryHint: ${err.recoveryHint})`,
  };
}

export function emptyResult(events: DiscoverEvent[]): FullCrawlResult {
  return {
    events,
    discovered: new Map(),
    listOps: 0,
    readOps: 0,
    finalizedSchemas: new Map(),
    complete: true,
  };
}

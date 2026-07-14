/**
 * Home command typeahead — fuzzy suggestions over all KEYED resources.
 *
 * PURE (like `command.ts`, its sibling): scoring, grouping, and entry-building
 * take plain data in and return plain data out; the index is BUILT by
 * `useResourceIndex` (the impure seam over the existing worker handles) and
 * handed in here. Groups render under headers by resource type; the existing
 * tab-navigation matches (`matchCommands`) stay at the top. Results contain
 * routes only — never settings or configuration (M4).
 *
 * Indexed resources (each capped at build time, see `INDEX_CAPS`):
 *   - Firestore root collections + shallow document paths per collection
 *   - Auth users, matched by email AND uid
 *   - Storage object refs
 *   - RTDB top-level keys
 */

import {
  matchCommands,
  type CommandResult,
  type CommandRoute,
  type CommandTarget,
} from './command.js';

export type ResourceKind =
  | 'collection'
  | 'document'
  | 'subcollection'
  | 'user'
  | 'object'
  | 'rtdb-key';

export interface ResourceEntry {
  kind: ResourceKind;
  /** Display text and the primary fuzzy-match haystack. */
  label: string;
  /** Secondary match haystack (a user's uid when the label is the email). */
  alt?: string;
  target: CommandTarget;
}

export interface SuggestionGroup {
  kind: 'navigate' | ResourceKind;
  title: string;
  results: CommandResult[];
}

/** Stable resource identity: labels can change (an Auth user's email), while
 * the routed target remains the same resource. */
export function resourceEntryIdentity(entry: ResourceEntry): string {
  return `${entry.kind}:${entry.target.tab}:${(entry.target.rest ?? []).join('/')}`;
}

/** Build-time caps (the index is a suggestion source, not a mirror). The caps
 *  bound the FETCHES, not just the kept entries: doc queries carry a limit(),
 *  only the first `collectionsScanned` collections get a doc query at all, and
 *  the storage BFS is bounded in listAll RPC count (`storageListCalls`) as
 *  well as objects. `users` is a client-side slice — the worker's
 *  `auth.listUsers` op has no server-side max today. */
export interface IndexCaps {
  docsPerCollection: number;
  /** Max collections that get a shallow doc-listing query per build. */
  collectionsScanned: number;
  users: number;
  objects: number;
  /** Max `listAll` RPCs per build (the BFS cost, independent of hit count). */
  storageListCalls: number;
  /** Max subcollection entries kept per build — the collection-group walk
   *  (see {@link bfsFirestoreSubcollections}) is doubly capped, like storage. */
  subcollections: number;
  /** Max `listSubcollections` RPCs per build (the BFS cost, independent of
   *  hit count) — bounds a deep/wide tree from fanning out unboundedly. */
  subcollectionRpcCalls: number;
}

export const INDEX_CAPS: IndexCaps = {
  docsPerCollection: 50,
  collectionsScanned: 20,
  users: 100,
  objects: 200,
  storageListCalls: 20,
  subcollections: 30,
  subcollectionRpcCalls: 40,
};

/**
 * Bounded breadth-first walk over a storage folder tree via injected
 * `listAll`. Object stores are flat key spaces surfaced as folders, so BFS
 * finds shallow refs first. DOUBLY capped: stops at `maxObjects` collected
 * paths AND at `maxListCalls` listAll RPCs — a deep/wide prefix tree cannot
 * fan out into unbounded round-trips just because few objects matched.
 */
export async function bfsStorageObjectPaths<Ref>(
  root: Ref,
  listAll: (ref: Ref) => Promise<{ items: ReadonlyArray<{ fullPath: string }>; prefixes: readonly Ref[] }>,
  { maxObjects, maxListCalls }: { maxObjects: number; maxListCalls: number },
): Promise<string[]> {
  const paths: string[] = [];
  const queue: Ref[] = [root];
  let calls = 0;
  while (queue.length && paths.length < maxObjects && calls < maxListCalls) {
    calls++;
    const res = await listAll(queue.shift() as Ref);
    for (const item of res.items) {
      if (paths.length >= maxObjects) break;
      paths.push(item.fullPath);
    }
    queue.push(...res.prefixes);
  }
  return paths;
}

export interface FirestoreSubcollectionWalkResult {
  /** Full collection paths, e.g. `customers/acme/users` — a subcollection
   *  literally named `users` nested under a document that is NOT `users/*`. */
  subcollections: string[];
  /** Full doc paths found inside those subcollections — lets a deep query
   *  (`users/david/orders/or`) complete at every segment, not just the root. */
  documents: string[];
}

/**
 * Bounded breadth-first walk of the Firestore subcollection tree, rooted at
 * the document paths already in the index (the shallow per-collection doc
 * scan `buildResourceIndex` already did). Mirrors {@link bfsStorageObjectPaths}:
 * DOUBLY capped — `maxSubcollections` bounds the kept entries, `maxRpcCalls`
 * bounds the `listSubcollections` round-trips — so a deep/wide document tree
 * cannot fan out into unbounded RPCs just because few subcollections matched.
 * Each subcollection found also gets one `listDocumentPaths` call (the SAME
 * source `buildResourceIndex` uses for root collections — a subcollection
 * path is just a longer, odd-segment-count collection path) so its direct
 * documents join the index and become the next level's BFS roots.
 */
export async function bfsFirestoreSubcollections(
  rootDocPaths: readonly string[],
  listSubcollections: (docPath: string) => Promise<readonly string[]>,
  listDocumentPaths: (collectionPath: string, cap: number) => Promise<readonly string[]>,
  { maxSubcollections, maxRpcCalls, docsPerCollection }: {
    maxSubcollections: number;
    maxRpcCalls: number;
    docsPerCollection: number;
  },
): Promise<FirestoreSubcollectionWalkResult> {
  const subcollections: string[] = [];
  const documents: string[] = [];
  const queue: string[] = [...rootDocPaths];
  let calls = 0;
  while (queue.length && subcollections.length < maxSubcollections && calls < maxRpcCalls) {
    const docPath = queue.shift() as string;
    calls++;
    let subIds: readonly string[] = [];
    try {
      subIds = await listSubcollections(docPath);
    } catch {
      continue;
    }
    for (const subId of subIds) {
      if (subcollections.length >= maxSubcollections) break;
      const collPath = `${docPath}/${subId}`;
      subcollections.push(collPath);
      try {
        const docPaths = await listDocumentPaths(collPath, docsPerCollection);
        for (const p of docPaths.slice(0, docsPerCollection)) {
          documents.push(p);
          queue.push(p);
        }
      } catch {
        // skip this subcollection's docs; the subcollection entry still stands
      }
    }
  }
  return { subcollections, documents };
}

const PER_GROUP_CAP = 5;

/**
 * Rank a fuzzy match: 0 = no match; higher = better. Tiers: exact (1000) >
 * prefix (~900) > substring (~700, earlier is better) > subsequence (~400,
 * denser and earlier is better) — so `users/al` beats a scattered
 * subsequence hit, and short prefixes surface their exact resource first.
 */
export function fuzzyScore(query: string, text: string): number {
  const q = query.toLowerCase();
  const t = text.toLowerCase();
  if (!q || !t) return 0;
  if (t === q) return 1000;
  if (t.startsWith(q)) return 900 - Math.min(t.length - q.length, 100);
  const at = t.indexOf(q);
  if (at !== -1) return 700 - Math.min(at, 100);
  let i = 0;
  let first = -1;
  let last = -1;
  for (let j = 0; j < t.length && i < q.length; j++) {
    if (t[j] === q[i]) {
      if (first === -1) first = j;
      last = j;
      i++;
    }
  }
  if (i !== q.length) return 0;
  const span = last - first + 1;
  return Math.max(1, 400 - (span - q.length) * 10 - Math.min(first, 50));
}

const GROUP_TITLES: Record<ResourceKind, string> = {
  collection: 'Firestore collections',
  document: 'Firestore documents',
  subcollection: 'Firestore subcollections',
  user: 'Auth users',
  object: 'Storage objects',
  'rtdb-key': 'RTDB keys',
};

const GROUP_ORDER: readonly ResourceKind[] = [
  'collection',
  'document',
  'subcollection',
  'user',
  'object',
  'rtdb-key',
];

function hintFor(entry: ResourceEntry): string {
  switch (entry.kind) {
    case 'collection':
      return 'Firestore collection';
    case 'document':
      return 'Firestore document';
    case 'subcollection':
      // `entry.alt` carries the parent doc path (see `subcollectionEntry`) so
      // a collection-group match is distinguishable from its siblings —
      // "customers/acme/users" and "customers/nomo/users" both look like
      // `users` at a glance without it.
      return entry.alt ? `Subcollection of /${entry.alt}` : 'Subcollection';
    case 'user':
      return entry.alt ? `Auth user · uid ${entry.alt}` : 'Auth user';
    case 'object':
      return 'Storage object';
    case 'rtdb-key':
      return 'RTDB top-level key';
  }
}

/** A slash-terminated query means "list what's directly under this exact
 *  path" — the trailing slash is not part of the fuzzy text. */
function splitTrailingSlash(query: string): { base: string; trailing: boolean } {
  return query.endsWith('/') ? { base: query.slice(0, -1), trailing: true } : { base: query, trailing: false };
}

/**
 * Path-aware "drill down" score for a `/`-joined entry label (a document, or
 * a document inside a subcollection). Every query segment except the last
 * must match the label's segment at the same position EXACTLY
 * (case-insensitive) — that's "I know the parent, complete the last leg":
 * `users/da` → `users/david`, `users/david/orders/or` → `users/david/orders/ord1`.
 * A trailing-slash query (`users/`) lists everything directly under that
 * exact parent. Returns 0 when the parent segments don't line up (a plain
 * `fuzzyScore` or {@link ownIdScore} match is tried instead by the caller).
 */
export function drillScore(query: string, label: string): number {
  const { base, trailing } = splitTrailingSlash(query);
  if (!base) return 0;
  const qSegs = base.split('/');
  const lSegs = label.split('/');
  if (qSegs.length > lSegs.length) return 0;
  const lastIdx = qSegs.length - 1;
  for (let i = 0; i < lastIdx; i++) {
    if (qSegs[i]!.toLowerCase() !== lSegs[i]!.toLowerCase()) return 0;
  }
  if (trailing) {
    return qSegs[lastIdx]!.toLowerCase() === lSegs[lastIdx]!.toLowerCase() ? 850 : 0;
  }
  return fuzzyScore(qSegs[lastIdx]!, lSegs[lastIdx]!);
}

/**
 * Collection-group score: does the entry's OWN last path segment (its
 * collection/subcollection id) match the query, regardless of what sits
 * above it in the tree? Only applies to a query with NO parent segment of
 * its own — `users` or `users/` — so it surfaces every collection or
 * subcollection literally named `users` anywhere, e.g. a subcollection at
 * `customers/acme/users`. A query with an explicit parent (`customers/acme/us`)
 * is a drill-down instead — {@link drillScore} handles that.
 */
export function ownIdScore(query: string, label: string): number {
  const { base, trailing } = splitTrailingSlash(query);
  if (!base || base.includes('/')) return 0;
  const ownId = label.split('/').pop() ?? label;
  if (trailing) return ownId.toLowerCase() === base.toLowerCase() ? 850 : 0;
  return fuzzyScore(base, ownId);
}

/**
 * Match `input` against the tab routes (top group, via the existing
 * `matchCommands`) and the resource index, grouped with headers by resource
 * type. Each group is capped and sorted by score, ties by label.
 */
export function matchTypeahead(
  input: string,
  routes: readonly CommandRoute[],
  entries: readonly ResourceEntry[],
  capPerGroup = PER_GROUP_CAP,
): SuggestionGroup[] {
  const q = input.trim();
  if (!q) return [];

  const groups: SuggestionGroup[] = [];
  const nav = matchCommands(input, routes);
  if (nav.length) groups.push({ kind: 'navigate', title: 'Go to', results: nav });

  for (const kind of GROUP_ORDER) {
    // Path-aware kinds layer `drillScore` (known parent, complete the last
    // leg) and `ownIdScore` (no parent given — a bare collection-group name
    // like `users`/`users/` matches ANY collection/subcollection called
    // that, anywhere in the tree) on top of the generic fuzzy match. A
    // trailing slash defeats plain `fuzzyScore` (no label contains a literal
    // `/` at the query's end), which is exactly what those two helpers exist
    // to recover.
    const pathAware = kind === 'document' || kind === 'subcollection';
    const groupable = kind === 'collection' || kind === 'subcollection';
    const uniqueEntries = new Map<string, ResourceEntry>();
    for (const entry of entries) {
      if (entry.kind === kind) uniqueEntries.set(resourceEntryIdentity(entry), entry);
    }
    const scored = [...uniqueEntries.values()]
      .map((e) => ({
        entry: e,
        score: Math.max(
          fuzzyScore(q, e.label),
          e.alt ? fuzzyScore(q, e.alt) : 0,
          pathAware ? drillScore(q, e.label) : 0,
          groupable ? ownIdScore(q, e.label) : 0,
        ),
      }))
      .filter((s) => s.score > 0)
      .sort((a, b) => b.score - a.score || a.entry.label.localeCompare(b.entry.label))
      .slice(0, capPerGroup);
    if (scored.length) {
      groups.push({
        kind,
        title: GROUP_TITLES[kind],
        results: scored.map(({ entry }) => ({
          id: resourceEntryIdentity(entry),
          label: entry.label,
          hint: hintFor(entry),
          target: entry.target,
        })),
      });
    }
  }
  return groups;
}

/** The groups' results in render order — the keyboard-navigation list. */
export function flattenSuggestions(groups: readonly SuggestionGroup[]): CommandResult[] {
  return groups.flatMap((g) => g.results);
}

// ─── Entry builders (pure) ──────────────────────────────────────────────────

export function collectionEntry(id: string): ResourceEntry {
  return { kind: 'collection', label: id, target: { tab: 'firestore', rest: [id] } };
}

export function documentEntry(path: string): ResourceEntry {
  return {
    kind: 'document',
    label: path,
    target: { tab: 'firestore', rest: path.split('/').filter(Boolean) },
  };
}

/** `path` is the full subcollection path, e.g. `customers/acme/users` —
 *  odd segment count, same shape `collection()` takes. `alt` carries the
 *  parent document path (`customers/acme`) for the "Subcollection of /…"
 *  hint (see `hintFor`). */
export function subcollectionEntry(path: string): ResourceEntry {
  const segs = path.split('/').filter(Boolean);
  const parentDocPath = segs.slice(0, -1).join('/');
  return {
    kind: 'subcollection',
    label: path,
    alt: parentDocPath || undefined,
    target: { tab: 'firestore', rest: segs },
  };
}

export function userEntry(user: { uid: string; email?: string | null }): ResourceEntry {
  return user.email
    ? { kind: 'user', label: user.email, alt: user.uid, target: { tab: 'auth', rest: [user.uid] } }
    : { kind: 'user', label: user.uid, target: { tab: 'auth', rest: [user.uid] } };
}

export function objectEntry(fullPath: string): ResourceEntry {
  return {
    kind: 'object',
    label: fullPath,
    target: { tab: 'storage', rest: fullPath.split('/').filter(Boolean) },
  };
}

export function rtdbKeyEntry(key: string): ResourceEntry {
  return { kind: 'rtdb-key', label: key, target: { tab: 'rtdb', rest: [key] } };
}

// ─── Index builder (async, injected sources — testable without a sandbox) ───

/** The listing seams the index reads. All existing ops (studio-data handles /
 *  the worker API bundles); the builder adds NO new backend operations. */
export interface ResourceIndexSources {
  listRootCollections?: () => readonly string[] | Promise<readonly string[]>;
  /** Shallow doc ids for one collection, as full paths (`users/alice`). Also
   *  used for SUBcollection paths (`customers/acme/users`) — a subcollection
   *  path is just a longer, odd-segment-count collection path, so the same
   *  seam serves both without a second op. */
  listDocumentPaths?: (collectionId: string, cap: number) => Promise<readonly string[]>;
  /** Subcollection ids directly under one document path. Drives the
   *  collection-group walk ({@link bfsFirestoreSubcollections}); absent →
   *  the index has root collections/documents only, no subcollections. */
  listSubcollections?: (docPath: string) => Promise<readonly string[]>;
  listUsers?: (cap: number) => Promise<ReadonlyArray<{ uid: string; email?: string | null }>>;
  listStorageObjectPaths?: (cap: number) => Promise<readonly string[]>;
  listRtdbTopLevelKeys?: () => Promise<readonly string[]>;
}

/**
 * Build the resource index, best-effort per source: a failing or absent
 * source contributes nothing (the typeahead never blocks or throws for a
 * degraded service).
 *
 * CONCURRENT, NOT SEQUENTIAL: each source is a MessagePort/worker round-trip
 * in served mode, so awaiting them one after another means the FASTEST
 * source (usually Firestore's root collections) sits invisible behind the
 * SLOWEST (the storage BFS can be up to `storageListCalls` RPCs). Firestore
 * (collections → shallow docs → the subcollection walk, which itself must
 * run sequentially — later steps need earlier steps' ids) runs as one task;
 * users/storage/rtdb run as independent tasks alongside it. `onBatch`, when
 * given, fires as each step's entries land — Firestore-first in practice,
 * since it's usually fastest AND it's what a path-shaped query needs — so a
 * caller (the palette) can show partial results instead of waiting for the
 * whole build.
 */
export async function buildResourceIndex(
  sources: ResourceIndexSources,
  capOverrides: Partial<IndexCaps> = {},
  onBatch?: (batch: readonly ResourceEntry[]) => void,
): Promise<ResourceEntry[]> {
  const caps: IndexCaps = { ...INDEX_CAPS, ...capOverrides };
  const entries: ResourceEntry[] = [];
  const emit = (batch: ResourceEntry[]) => {
    if (!batch.length) return;
    entries.push(...batch);
    onBatch?.(batch);
  };

  const firestoreTask = (async () => {
    let collections: readonly string[] = [];
    try {
      collections = (await sources.listRootCollections?.()) ?? [];
    } catch {
      collections = [];
    }
    if (collections.length) emit(collections.map(collectionEntry));

    const docPaths: string[] = [];
    if (sources.listDocumentPaths) {
      // Fetch cap, not just a keep cap: one shallow doc query per collection
      // is a per-collection RPC in served mode, so only the first
      // `collectionsScanned` collections are queried (all still got a
      // collection entry above — those are free).
      for (const id of collections.slice(0, caps.collectionsScanned)) {
        try {
          const paths = await sources.listDocumentPaths(id, caps.docsPerCollection);
          const slice = paths.slice(0, caps.docsPerCollection);
          docPaths.push(...slice);
          emit(slice.map(documentEntry));
        } catch {
          // skip the collection
        }
      }
    }

    if (sources.listSubcollections && sources.listDocumentPaths) {
      try {
        const { subcollections, documents } = await bfsFirestoreSubcollections(
          docPaths,
          sources.listSubcollections,
          sources.listDocumentPaths,
          {
            maxSubcollections: caps.subcollections,
            maxRpcCalls: caps.subcollectionRpcCalls,
            docsPerCollection: caps.docsPerCollection,
          },
        );
        emit(subcollections.map(subcollectionEntry));
        emit(documents.map(documentEntry));
      } catch {
        // skip the subcollection walk
      }
    }
  })();

  const usersTask = (async () => {
    if (!sources.listUsers) return;
    try {
      const users = await sources.listUsers(caps.users);
      emit(users.slice(0, caps.users).map(userEntry));
    } catch {
      // skip users
    }
  })();

  const storageTask = (async () => {
    if (!sources.listStorageObjectPaths) return;
    try {
      const paths = await sources.listStorageObjectPaths(caps.objects);
      emit(paths.slice(0, caps.objects).map(objectEntry));
    } catch {
      // skip storage
    }
  })();

  const rtdbTask = (async () => {
    if (!sources.listRtdbTopLevelKeys) return;
    try {
      emit((await sources.listRtdbTopLevelKeys()).map(rtdbKeyEntry));
    } catch {
      // skip rtdb
    }
  })();

  await Promise.allSettled([firestoreTask, usersTask, storageTask, rtdbTask]);
  return entries;
}

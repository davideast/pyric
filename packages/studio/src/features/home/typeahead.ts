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

export type ResourceKind = 'collection' | 'document' | 'user' | 'object' | 'rtdb-key';

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

/** Build-time caps (the index is a suggestion source, not a mirror). */
export const INDEX_CAPS = {
  docsPerCollection: 50,
  users: 200,
  objects: 200,
} as const;

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
  user: 'Auth users',
  object: 'Storage objects',
  'rtdb-key': 'RTDB keys',
};

const GROUP_ORDER: readonly ResourceKind[] = [
  'collection',
  'document',
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
    case 'user':
      return entry.alt ? `Auth user · uid ${entry.alt}` : 'Auth user';
    case 'object':
      return 'Storage object';
    case 'rtdb-key':
      return 'RTDB top-level key';
  }
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
    const scored = entries
      .filter((e) => e.kind === kind)
      .map((e) => ({
        entry: e,
        score: Math.max(fuzzyScore(q, e.label), e.alt ? fuzzyScore(q, e.alt) : 0),
      }))
      .filter((s) => s.score > 0)
      .sort((a, b) => b.score - a.score || a.entry.label.localeCompare(b.entry.label))
      .slice(0, capPerGroup);
    if (scored.length) {
      groups.push({
        kind,
        title: GROUP_TITLES[kind],
        results: scored.map(({ entry }) => ({
          id: `${entry.kind}:${entry.label}`,
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
  /** Shallow doc ids for one collection, as full paths (`users/alice`). */
  listDocumentPaths?: (collectionId: string, cap: number) => Promise<readonly string[]>;
  listUsers?: (cap: number) => Promise<ReadonlyArray<{ uid: string; email?: string | null }>>;
  listStorageObjectPaths?: (cap: number) => Promise<readonly string[]>;
  listRtdbTopLevelKeys?: () => Promise<readonly string[]>;
}

/**
 * Build the resource index, best-effort per source: a failing or absent
 * source contributes nothing (the typeahead never blocks or throws for a
 * degraded service).
 */
export async function buildResourceIndex(
  sources: ResourceIndexSources,
  caps: { docsPerCollection: number; users: number; objects: number } = INDEX_CAPS,
): Promise<ResourceEntry[]> {
  const entries: ResourceEntry[] = [];

  let collections: readonly string[] = [];
  try {
    collections = (await sources.listRootCollections?.()) ?? [];
  } catch {
    collections = [];
  }
  for (const id of collections) entries.push(collectionEntry(id));

  if (sources.listDocumentPaths) {
    for (const id of collections) {
      try {
        const paths = await sources.listDocumentPaths(id, caps.docsPerCollection);
        for (const p of paths.slice(0, caps.docsPerCollection)) entries.push(documentEntry(p));
      } catch {
        // skip the collection
      }
    }
  }

  if (sources.listUsers) {
    try {
      const users = await sources.listUsers(caps.users);
      for (const u of users.slice(0, caps.users)) entries.push(userEntry(u));
    } catch {
      // skip users
    }
  }

  if (sources.listStorageObjectPaths) {
    try {
      const paths = await sources.listStorageObjectPaths(caps.objects);
      for (const p of paths.slice(0, caps.objects)) entries.push(objectEntry(p));
    } catch {
      // skip storage
    }
  }

  if (sources.listRtdbTopLevelKeys) {
    try {
      for (const key of await sources.listRtdbTopLevelKeys()) entries.push(rtdbKeyEntry(key));
    } catch {
      // skip rtdb
    }
  }

  return entries;
}

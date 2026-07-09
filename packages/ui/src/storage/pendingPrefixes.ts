/**
 * Pending (not-yet-materialized) folder prefixes — pure reducer, no React.
 *
 * MECHANISM DECISION (create-folder). GCS has no real folders: a
 * "folder" exists only as a shared prefix of object names. Two honest
 * ways to let a user create one before it contains anything:
 *
 *  a) write a zero-byte `<path>/` placeholder object (the emulator-UI
 *     convention — `useObjectUpload.createFolder` does this): the
 *     folder survives reloads, but every created folder deposits a
 *     phantom object in the sandbox store, and the trailing-slash ref
 *     is sandbox-only (prod `ref()` rejects it, and the Studio worker
 *     `StorageApi` path has no channel for it at all);
 *
 *  b) hold the created prefix as CLIENT-SIDE PENDING STATE and let the
 *     first upload into it materialize it for real. The store stays
 *     byte-for-byte clean — nothing is written until a file is — at
 *     the cost that a created-then-abandoned empty folder disappears
 *     on reload.
 *
 * Studio's create-folder flow uses (b): the sandbox store is the
 * user's actual data and must not accrue placeholder objects, and the
 * disappearing-empty-folder tradeoff is acceptable BECAUSE the UI
 * labels pending rows as session-only ("empty" badge + empty-state
 * copy in `StoragePane`). (a) remains available to consumers who want
 * persistent empty folders in sandbox-only setups.
 *
 * State is a sorted list of normalized bucket-rooted prefix paths (no
 * trailing slashes). Creating `stuff/things/cool` expands the whole
 * chain — `stuff`, `stuff/things`, `stuff/things/cool` — so every
 * ancestor level shows the folder while browsing (VS Code-style nested
 * create). A successful upload MATERIALIZES its destination folder:
 * the chain up to that folder leaves pending state (the real listing
 * now surfaces those prefixes); pending descendants of other branches
 * stay.
 */

import { normalizeStoragePath } from './hooks/usePathState.js';

/** Sorted, deduped, normalized pending prefix paths. */
export type PendingPrefixState = readonly string[];

export type PendingPrefixAction =
  /** Create a folder at `path` (absolute, bucket-rooted; nested paths
   *  allowed) — adds the full ancestor chain. */
  | { type: 'create'; path: string }
  /** An object now exists directly under `path`: drop `path` and its
   *  ancestors from pending (they are real prefixes now). */
  | { type: 'materialize'; path: string }
  | { type: 'clear' };

/** `'a/b/c'` → `['a', 'a/b', 'a/b/c']`; `''` → `[]`. */
export function expandPathChain(path: string): string[] {
  const normalized = normalizeStoragePath(path);
  if (normalized === '') return [];
  const segments = normalized.split('/');
  return segments.map((_, i) => segments.slice(0, i + 1).join('/'));
}

export const initialPendingPrefixes: PendingPrefixState = [];

export function pendingPrefixReducer(
  state: PendingPrefixState,
  action: PendingPrefixAction,
): PendingPrefixState {
  switch (action.type) {
    case 'create': {
      const chain = expandPathChain(action.path).filter((p) => !state.includes(p));
      if (chain.length === 0) return state;
      return [...state, ...chain].sort();
    }
    case 'materialize': {
      const real = new Set(expandPathChain(action.path));
      if (real.size === 0) return state;
      const next = state.filter((p) => !real.has(p));
      return next.length === state.length ? state : next;
    }
    case 'clear':
      return state.length === 0 ? state : initialPendingPrefixes;
  }
}

/** Direct-child folder NAMES pending under `parentPath` (`''` = root),
 *  sorted. The chain expansion guarantees every level is present, so a
 *  simple parent match is exact. */
export function pendingChildFolders(
  state: PendingPrefixState,
  parentPath: string,
): string[] {
  const parent = normalizeStoragePath(parentPath);
  const prefix = parent === '' ? '' : `${parent}/`;
  return state
    .filter((p) => p.startsWith(prefix) && p !== parent && !p.slice(prefix.length).includes('/'))
    .map((p) => p.slice(prefix.length));
}

/** Whether `path` itself is a pending (session-only) folder. */
export function isPendingPrefix(state: PendingPrefixState, path: string): boolean {
  return state.includes(normalizeStoragePath(path));
}

/**
 * Validate a create-folder input (relative to the current folder;
 * nested `a/b/c` allowed — VS Code semantics). Returns an error
 * message or `null` when valid. Normalization tolerates stray/repeat
 * slashes; `.`/`..` segments are rejected (GCS object names have no
 * dot-segment semantics — accepting them would create unreachable
 * names).
 */
export function folderInputError(input: string): string | null {
  const normalized = normalizeStoragePath(input);
  if (normalized === '') return 'Enter a folder name.';
  const segments = normalized.split('/');
  if (segments.some((s) => s === '.' || s === '..')) {
    return 'Folder names may not be "." or "..".';
  }
  return null;
}

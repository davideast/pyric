/**
 * Public entry for the workspace VFS.
 *
 * In the browser, `getVFS()` returns a SESSION-SCOPED adapter: the
 * virtual `/` is mounted at the per-session OPFS container
 * `/sessions/{sessionId}` (so virtual `/workspace/...` lives at the
 * real path `/sessions/{sessionId}/workspace/...`). Every existing
 * caller — file tools, FileEditor/FilesPanel, terminal, checkpoints
 * git repo, preview compiler — keeps using the same virtual paths
 * unchanged; only the mount moves. Two sessions (or two tabs on
 * different sessions) therefore operate on disjoint trees.
 *
 * The active session id is wired in ONE place: the session routing
 * layer calls `ensureSessionVFS(sessionId)` during page hydration
 * (`useSessionRouting`), before any component that touches files
 * mounts. As a defensive fallback, `getVFS()` also reads
 * `?session={id}` straight from the URL — the playground page always
 * carries it. With neither available, `getVFS()` throws rather than
 * silently mounting a shared global root (that was the bug).
 *
 * When OPFS is unavailable (a Node/`bun` headless harness), this
 * falls back to the in-memory adapter exactly as before — no session
 * concept, no scoping; `resetVFS()` isolation between fixtures keeps
 * working byte-identically. See `memory-adapter.ts`.
 */

import { createOPFSAdapter, type OPFSAdapter, type OPFSPromisesAPI } from './opfs-adapter';
import { createMemoryVFSAdapter } from './memory-adapter';
import { createScopedVFSAdapter } from './scoped-adapter';
import { migrateLegacyWorkspace } from './migrate';

let singleton: OPFSAdapter | null = null;
/** What the cached singleton was built for: a session id (scoped OPFS
 *  adapter) or `:memory:` (headless). */
let singletonKey: string | null = null;
/** Raw (unscoped) OPFS adapter — shared by every scoped mount and by
 *  the legacy migration, so all of them see one metadata store. */
let rawAdapter: OPFSAdapter | null = null;
let activeSessionId: string | null = null;
/** Per-tab write gate — flipped by the session writer-lock wiring
 *  (`useSessionRouting`) when this tab is NOT the session's writer. */
let vfsReadOnly = false;

/** True when the Origin Private File System is reachable (browser only). */
function opfsAvailable(): boolean {
  return (
    typeof navigator !== 'undefined' &&
    typeof (navigator as { storage?: { getDirectory?: unknown } }).storage?.getDirectory ===
      'function'
  );
}

/** Session ids come from `crypto.randomUUID()` (or a base36 fallback),
 *  but they travel through the URL — sanitize before using one as an
 *  OPFS directory name so a crafted id can't traverse the tree. */
function sanitizeSessionId(id: string): string {
  return id.replace(/[^A-Za-z0-9._-]/g, '_').replace(/^\.+$/, '_');
}

function sessionIdFromUrl(): string | null {
  if (typeof window === 'undefined') return null;
  const search = (window as { location?: { search?: string } }).location?.search;
  if (!search) return null;
  const raw = new URLSearchParams(search).get('session');
  return raw ? sanitizeSessionId(raw) : null;
}

/** Real OPFS path of a session's container directory. */
export function sessionContainerRoot(sessionId: string): string {
  return `/sessions/${sanitizeSessionId(sessionId)}`;
}

/** Point the VFS at a session container. Called from the session
 *  routing layer (the one wiring point); subsequent `getVFS()` calls
 *  return an adapter mounted at that session's container. */
export function setActiveVFSSessionId(sessionId: string): void {
  const safe = sanitizeSessionId(sessionId);
  if (activeSessionId === safe) return;
  activeSessionId = safe;
  // Drop a singleton scoped to a different session — the next
  // `getVFS()` rebuilds against the new mount. (In practice session
  // switches are full page navigations, so this is belt-and-braces.)
  if (singletonKey !== null && singletonKey !== ':memory:' && singletonKey !== safe) {
    singleton = null;
    singletonKey = null;
  }
}

export function getActiveVFSSessionId(): string | null {
  return activeSessionId;
}

/** Flip the per-tab write gate. Non-writer tabs (session open in
 *  another tab) get a read-only VFS: every mutating call rejects with
 *  `EROFS`, blocking file tools, editor saves, terminal writes and
 *  checkpoint commits at one chokepoint. */
export function setVFSReadOnly(readOnly: boolean): void {
  vfsReadOnly = readOnly;
}

export function isVFSReadOnly(): boolean {
  return vfsReadOnly;
}

function getRawOPFSAdapter(): OPFSAdapter {
  if (!rawAdapter) rawAdapter = createOPFSAdapter();
  return rawAdapter;
}

export function getVFS(): OPFSAdapter {
  if (!opfsAvailable()) {
    // Headless harness path — in-memory adapter, no session scoping.
    if (!singleton || singletonKey !== ':memory:') {
      singleton = createMemoryVFSAdapter();
      singletonKey = ':memory:';
    }
    return singleton;
  }
  const id = activeSessionId ?? sessionIdFromUrl();
  if (!id) {
    throw new Error(
      '[vfs] getVFS() called before a session was established. The playground ' +
        'mounts the VFS at a per-session container — call ensureSessionVFS(sessionId) ' +
        '(done by useSessionRouting) or navigate with ?session={id} first.',
    );
  }
  if (!singleton || singletonKey !== id) {
    activeSessionId = id;
    singleton = createScopedVFSAdapter(getRawOPFSAdapter(), {
      realRoot: sessionContainerRoot(id),
      canWrite: () => !vfsReadOnly,
    });
    singletonKey = id;
  }
  return singleton;
}

/**
 * Establish the VFS mount for `sessionId` and run the one-time legacy
 * migration: if the pre-container global `/workspace` still exists in
 * OPFS, its content (files, helpers, the checkpoints git repo) is
 * moved into THIS session's container so no work is lost, then the
 * legacy root is deleted. Idempotent — later loads find no legacy
 * root and no-op. Call before the first file access of a page load;
 * `useSessionRouting` does this during hydration.
 *
 * Pass `migrate: false` for read-only tabs (non-writers must not
 * mutate OPFS; the writer tab owns the migration).
 */
export async function ensureSessionVFS(
  sessionId: string,
  options?: { migrate?: boolean },
): Promise<void> {
  setActiveVFSSessionId(sessionId);
  if (!opfsAvailable()) return;
  if (options?.migrate === false) return;
  const result = await migrateLegacyWorkspace(
    getRawOPFSAdapter(),
    sessionContainerRoot(sessionId),
  );
  if (result.migrated) {
    console.info(
      `[vfs] recovered legacy global /workspace (${result.files} file(s)) into session container '${sanitizeSessionId(sessionId)}'`,
    );
  }
}

/** Drop the cached adapter so the next `getVFS()` builds a fresh one.
 *  Headless harnesses call this between fixtures to isolate workspaces;
 *  with the in-memory adapter that fully resets the file system. */
export function resetVFS(): void {
  singleton = null;
  singletonKey = null;
  rawAdapter = null;
  activeSessionId = null;
  vfsReadOnly = false;
}

export type { OPFSAdapter, OPFSPromisesAPI };

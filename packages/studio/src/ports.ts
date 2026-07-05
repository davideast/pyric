/**
 * Pyric Studio storage ports (Phase 0 contract C3).
 *
 * Studio depends ONLY on these interfaces; `createStudioEnvironment(mode)` (see
 * `./env.ts`) wires concrete impls + transport per mode. Ship `local` (disk via
 * the pyric server); `browser` (= today's playground over IDB) and `hosted`
 * (remote) are future factory branches. The interfaces are shaped from the
 * UNION of disk + playground so playground can be re-expressed as the `browser`
 * impl. See the design rationale.
 */

import type { PersistenceBackend } from 'pyric/sandbox';

// ─── WorkspaceStore, file-tree-general ────────────────────────────────────
//
// A real project file tree. Playground's `{ rules, code, appSource }` is a
// LENS over well-known paths (`firestore.rules`, the app source, `firebase.json`
// / `seed.json`); `.pyric/` holds sandbox state the user doesn't hand-edit.
// Disk impl = fs + watcher (served at `/__pyric/workspace`); future `browser`
// impl = a virtual FS over IndexedDB.

export interface WorkspaceEntry {
  /** Project-relative POSIX path. */
  path: string;
  kind: 'file' | 'dir';
}

export interface WorkspaceChange {
  path: string;
  type: 'create' | 'update' | 'delete';
}

export interface WorkspaceStore {
  /** File contents, or `null` if it doesn't exist. */
  read(path: string): Promise<string | null>;
  write(path: string, content: string): Promise<void>;
  /** Entries directly under `dir` (project root when omitted). */
  list(dir?: string): Promise<WorkspaceEntry[]>;
  remove(path: string): Promise<void>;
  /** Live edits (disk watcher / IDB change events). Returns an unsubscribe. */
  watch(cb: (change: WorkspaceChange) => void): () => void;
}

// ─── ProjectStore, sessions/projects ──────────────────────────────────────
//
// One entry in `pyric serve` single-project mode; N in a multi-project/hosted
// mode. `ProjectMeta` is shaped to absorb playground's `SessionMeta` (title,
// timestamps, and (additively, later) `promotedTo` / `githubRepo` / exports).

export interface ProjectMeta {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
}

export interface ProjectHandle {
  meta: ProjectMeta;
  workspace: WorkspaceStore;
}

export interface ProjectStore {
  list(): Promise<ProjectMeta[]>;
  open(id: string): Promise<ProjectHandle>;
  create(input: { title?: string }): Promise<ProjectMeta>;
  update(id: string, patch: Partial<Omit<ProjectMeta, 'id'>>): Promise<void>;
  remove(id: string): Promise<void>;
}

// ─── RemoteLifecycle, github / promote / export ───────────────────────────
//
// Orthogonal to where storage lives. Optional; modes implement what they
// support (local: git/creds; hosted: a remote API). Method shapes firm up with
// the implementing tracks; kept loose here so the contract doesn't over-commit.

export interface RemoteLifecycle {
  linkGithub?(projectId: string, repo: { fullName: string }): Promise<void>;
  promote?(projectId: string, target: { projectId: string }): Promise<void>;
  export?(projectId: string): Promise<{ exportId: string }>;
}

// ─── PersistenceBackend, reuse (already polymorphic in pyric) ─────────────
//
// Sandbox durable state. pyric already ships IDB / memory / `--persist`
// HTTP-to-disk impls; Studio reuses the type as-is.
export type { PersistenceBackend };

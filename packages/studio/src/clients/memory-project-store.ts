/**
 * `createMemoryProjectStore()`: an in-process, single-project {@link
 * ProjectStore} for `STUDIO_STATIC` builds (the composed static site — no
 * pyric devr behind it, so `/__pyric/workspace` and `/__pyric/projects` don't
 * exist). Backs Studio's project/workspace ports with a `Map`, scoped to the
 * tab's lifetime.
 *
 * This is NOT where durable sandbox state lives — Firestore/Auth/RTDB records
 * persist via the SharedWorker's own IDB backend (see `worker/entry.ts`),
 * reached through `StudioEnvironment.live`/`persistence`, independent of this
 * store. This store only stands in for the workspace/file-tree port so
 * `createStudioEnvironment('local', { … })` never has to reach a server that
 * isn't there under static hosting.
 */
import type {
  ProjectHandle,
  ProjectMeta,
  ProjectStore,
  WorkspaceChange,
  WorkspaceEntry,
  WorkspaceStore,
} from '../ports.js';

const SINGLE_PROJECT_ID = 'local';

function createMemoryWorkspace(): WorkspaceStore {
  const files = new Map<string, string>();
  const watchers = new Set<(change: WorkspaceChange) => void>();
  const notify = (change: WorkspaceChange): void => {
    for (const cb of watchers) cb(change);
  };

  return {
    async read(path) {
      return files.has(path) ? files.get(path)! : null;
    },
    async write(path, content) {
      const type = files.has(path) ? 'update' : 'create';
      files.set(path, content);
      notify({ path, type });
    },
    async list(dir) {
      const prefix = dir ? `${dir.replace(/\/+$/, '')}/` : '';
      const entries: WorkspaceEntry[] = [];
      for (const path of files.keys()) {
        if (prefix && !path.startsWith(prefix)) continue;
        entries.push({ path, kind: 'file' });
      }
      return entries;
    },
    async remove(path) {
      if (files.delete(path)) notify({ path, type: 'delete' });
    },
    watch(cb) {
      watchers.add(cb);
      return () => watchers.delete(cb);
    },
  };
}

/**
 * Single-project, in-memory `ProjectStore`. `list()` always returns the one
 * project; `open` resolves it; `create`/`remove` are no-ops (or throw a
 * clearly-labeled error for `create`, since fabricating a second project
 * silently would be surprising) — static Studio never had more than one
 * project to switch between.
 */
export function createMemoryProjectStore(): ProjectStore {
  const workspace = createMemoryWorkspace();
  let meta: ProjectMeta = {
    id: SINGLE_PROJECT_ID,
    title: 'Local Project',
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };

  return {
    async list() {
      return [meta];
    },
    async open(id) {
      if (id !== meta.id) {
        throw new Error(
          `Static Studio runs in single-project mode — no project '${id}'.`,
        );
      }
      const handle: ProjectHandle = { meta, workspace };
      return handle;
    },
    async create() {
      throw new Error(
        'Static Studio runs in single-project mode — creating additional projects is not supported.',
      );
    },
    async update(id, patch) {
      if (id !== meta.id) return;
      meta = { ...meta, ...patch, updatedAt: Date.now() };
    },
    async remove() {
      // Single-project mode: the one project can never be removed. A no-op
      // (rather than a throw) keeps this a safe default action for any UI
      // that calls it unconditionally.
    },
  };
}

/**
 * Studio storage (Track T3) — disk-backed `WorkspaceStore` / `ProjectStore`
 * impls + the `/__pyric/workspace` and `/__pyric/projects` serve routes that
 * `@pyric/studio`'s `local` mode talks to. See the design rationale.
 */
export { diskWorkspace, resolveWorkspacePath, WorkspacePathError } from './disk-workspace.js';
export {
  diskProjectStore,
  slugifyProjectId,
  ProjectIdError,
} from './disk-project-store.js';
export { createStudioRoutes, type StudioRouteOptions } from './routes.js';
export type {
  ProjectHandle,
  ProjectMeta,
  ProjectStore,
  WorkspaceChange,
  WorkspaceEntry,
  WorkspaceStore,
} from './store-types.js';

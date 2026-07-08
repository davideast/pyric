/**
 * Studio `local`-mode HTTP clients: browser-side impls of the storage ports
 * over the pyric devr's `/__pyric/*` routes (Track T3). Wired by
 * `createStudioEnvironment('local')` (see `../env.ts`).
 */
export { httpWorkspace } from './http-workspace.js';
export { httpProjectStore } from './http-project-store.js';
export { httpPersistence } from './http-persistence.js';

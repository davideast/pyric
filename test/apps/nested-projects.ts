/**
 * Every project a scenario installs inside its app directory with
 * `app.installProject(path)`, and where that project's package.json comes
 * from (#1514). Nested installs come from the dependency store like the
 * shared ones, so each project's store key must be known before the run:
 * a project scaffolded by a create-pyric template is keyed by scaffolding the
 * template, and a directory in the app by its package.json.
 *
 * `installProject` refuses a path this list does not name. A scenario that
 * installs a new nested project adds it here.
 */

/** Where a nested project's package.json comes from. */
export type NestedManifestSource =
  /** `create-pyric <path> --template <template>`, run in the app directory. */
  | { template: 'chat' | 'node' | 'web' }
  /** A directory the app ships, relative to the app directory. */
  | { dir: string };

export interface NestedProject {
  /** The app directory under test/apps/. */
  app: string;
  /** The path the scenario passes to `installProject`, relative to the app directory. */
  path: string;
  manifest: NestedManifestSource;
}

/** This file, for messages that tell a scenario author where to declare a project. */
export const NESTED_PROJECTS_FILE = 'test/apps/nested-projects.ts';

export const NESTED_PROJECTS: readonly NestedProject[] = [
  { app: 'create-pyric-chat-app-check', path: 'my-chat', manifest: { template: 'chat' } },
  { app: 'create-pyric-chat-node-host', path: 'my-chat', manifest: { template: 'chat' } },
  { app: 'create-pyric-node-template', path: 'my-node-app', manifest: { template: 'node' } },
  { app: 'run-from-sibling-install', path: 'tools', manifest: { dir: 'tools' } },
  { app: 'run-from-sibling-install', path: 'backend', manifest: { dir: 'backend' } },
  { app: 'run-names-hosted-for-in-page-vite', path: 'my-web', manifest: { template: 'web' } },
];

/** The declared nested project `path` of `app`, or undefined when the list does not name it. */
export function nestedProject(app: string, path: string): NestedProject | undefined {
  return NESTED_PROJECTS.find((project) => project.app === app && project.path === path);
}

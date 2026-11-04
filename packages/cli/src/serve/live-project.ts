/**
 * The Firebase project a live mode start names. Every live entry, the
 * `pyric-live` command, `@pyric/live/vite` and `@pyric/live/register`, reads
 * it here, as `resolveFirebaseProject` resolves any served project, so the
 * start line, the chip and Studio all name one project. It comes from the
 * app's own Firebase config; pyric holds no production credential.
 *
 * Only the live seams import this module.
 */
import { resolveFirebaseProject, type FirebaseProjectResolution } from '../cli/firebase-project.js';

/** Thrown when no source names a project: live mode does not start without one. */
export class LiveProjectMissingError extends Error {
  readonly code = 'PYRIC_LIVE_NO_PROJECT';
  constructor(projectDir: string) {
    super(
      `Live mode did not start. No Firebase project is set for ${projectDir}, and live mode shows which project ` +
        'your app talks to. Set one with `firebase use <project-id>`, or name it in .firebaserc, then start again.',
    );
    this.name = 'LiveProjectMissingError';
  }
}

/** The project id in a resolution. Throws {@link LiveProjectMissingError} when there is none. */
export function requireLiveProject(resolution: FirebaseProjectResolution, projectDir: string): string {
  const projectId = resolution.projectId;
  const hasProject = projectId !== undefined && projectId !== '';
  if (!hasProject) throw new LiveProjectMissingError(projectDir);
  return projectId;
}

/** The project a live start in `projectDir` names. `option` is the Vite plugin's `project`. */
export function liveProjectId(projectDir: string, option?: string): string {
  return requireLiveProject(resolveFirebaseProject({ projectDir, option }), projectDir);
}

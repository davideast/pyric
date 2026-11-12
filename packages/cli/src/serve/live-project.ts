/**
 * The Firebase project a live mode start names. Every live entry, the
 * `pyric-live` command, `@pyric/live/vite` and `@pyric/live/register`, reads
 * it here, as `resolveFirebaseProject` resolves any served project, so the
 * start line, the chip and Studio all name one project. It comes from the
 * app's own Firebase config; pyric holds no production credential.
 *
 * Only the live seams import this module.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { findFirebaseProjectDir, resolveFirebaseProject, type FirebaseProjectResolution } from '../cli/firebase-project.js';

export function readPyricConfigProjectSync(projectDir: string): string | undefined {
  const candidates = [projectDir];
  const fbRoot = findFirebaseProjectDir(projectDir);
  if (fbRoot !== null && fbRoot !== projectDir) candidates.push(fbRoot);
  for (const dir of candidates) {
    try {
      const parsed = JSON.parse(readFileSync(join(dir, 'pyric.json'), 'utf8')) as { project?: unknown };
      if (typeof parsed?.project === 'string' && parsed.project.length > 0) {
        return parsed.project;
      }
    } catch {
      // Missing or unreadable pyric.json is ignored here.
    }
  }
  return undefined;
}

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
  const configProject = readPyricConfigProjectSync(projectDir);
  return requireLiveProject(resolveFirebaseProject({ projectDir, option, configProject }), projectDir);
}

/**
 * The project root a live Node process starts with (#2134): the nearest
 * folder from the working directory up that holds `.firebaserc` or
 * `firebase.json`, as the Firebase CLI finds its project root, so a server
 * started from `web/` in a workspace whose `.firebaserc` sits at the root
 * names that project. With no such folder up to the filesystem root, the
 * start still refuses with `LiveProjectMissingError`, naming the folder it
 * started from. Every case runs against a temporary HOME, so the user's own
 * `firebase use` configstore is never read.
 */
import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { findFirebaseProjectDir } from '../../src/cli/firebase-project.js';
import { LIVE_PROJECT_ROOT_VARIABLE, liveProjectRoot } from '../../src/register/live-package.js';
import { LiveProjectMissingError, liveProjectId } from '../../src/serve/live-project.js';

const PROJECT = 'demo-walk-up';
const FIREBASERC = JSON.stringify({ projects: { default: PROJECT } });

/** A fresh folder under the system temp folder, by real path. */
function freshDir(prefix: string): string {
  return realpathSync(mkdtempSync(join(tmpdir(), prefix)));
}

/** A project folder holding `files`, with `web/src/` two levels below it. */
function workspace(files: Record<string, string>): { root: string; web: string; nested: string } {
  const root = freshDir('pyric-live-walk-up-');
  for (const [name, contents] of Object.entries(files)) writeFileSync(join(root, name), contents);
  const nested = join(root, 'web', 'src');
  mkdirSync(nested, { recursive: true });
  return { root, web: join(root, 'web'), nested };
}

/** A process environment with nothing recorded and a HOME with no configstore. */
function freshEnv(): Record<string, string | undefined> {
  const home = freshDir('pyric-live-walk-up-home-');
  return { HOME: home, XDG_CONFIG_HOME: join(home, '.config') };
}

/** The project id a live start in `cwd` names, with no `firebase use` project and no PYRIC_PROJECT. */
function projectIdFrom(cwd: string): string {
  const env = freshEnv();
  const saved = { HOME: process.env.HOME, XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME, PYRIC_PROJECT: process.env.PYRIC_PROJECT };
  process.env.HOME = env.HOME;
  process.env.XDG_CONFIG_HOME = env.XDG_CONFIG_HOME;
  delete process.env.PYRIC_PROJECT;
  try {
    return liveProjectId(liveProjectRoot(env, cwd));
  } finally {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

describe('the live project root walks up from the working directory', () => {
  test('a .firebaserc in the working directory is the project root', () => {
    const { root } = workspace({ '.firebaserc': FIREBASERC });
    expect(findFirebaseProjectDir(root)).toBe(root);
    expect(liveProjectRoot(freshEnv(), root)).toBe(root);
    expect(projectIdFrom(root)).toBe(PROJECT);
  });

  test('a .firebaserc two levels up is the project root', () => {
    const { root, nested } = workspace({ '.firebaserc': FIREBASERC, 'firebase.json': '{}' });
    expect(findFirebaseProjectDir(nested)).toBe(root);
    expect(liveProjectRoot(freshEnv(), nested)).toBe(root);
    expect(projectIdFrom(nested)).toBe(PROJECT);
  });

  test('a firebase.json without a .firebaserc is the project root', () => {
    const { root, web } = workspace({ 'firebase.json': '{}' });
    expect(findFirebaseProjectDir(web)).toBe(root);
    expect(liveProjectRoot(freshEnv(), web)).toBe(root);
  });

  test('the nearest folder wins over one further up', () => {
    const { root, web, nested } = workspace({ '.firebaserc': FIREBASERC });
    writeFileSync(join(web, 'firebase.json'), '{}');
    expect(findFirebaseProjectDir(nested)).toBe(web);
    expect(findFirebaseProjectDir(root)).toBe(root);
  });

  test('with nothing up to the filesystem root, the start refuses naming the folder it started from', () => {
    const { nested } = workspace({});
    const hasMarkerAbove = findFirebaseProjectDir(tmpdir()) !== null;
    expect(hasMarkerAbove).toBe(false);
    expect(findFirebaseProjectDir(nested)).toBeNull();
    expect(liveProjectRoot(freshEnv(), nested)).toBe(nested);
    expect(() => projectIdFrom(nested)).toThrow(LiveProjectMissingError);
    expect(() => projectIdFrom(nested)).toThrow(`No Firebase project is set for ${nested},`);
  });

  test('a root the first process recorded wins over the walk-up', () => {
    const { root, web } = workspace({ '.firebaserc': FIREBASERC });
    const recorded = freshDir('pyric-live-walk-up-recorded-');
    expect(liveProjectRoot({ [LIVE_PROJECT_ROOT_VARIABLE]: recorded }, web)).toBe(recorded);
    expect(liveProjectRoot({ [LIVE_PROJECT_ROOT_VARIABLE]: '' }, web)).toBe(root);
  });
});

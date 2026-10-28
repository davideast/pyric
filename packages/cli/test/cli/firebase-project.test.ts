/**
 * The Firebase project a served project runs as, resolved as firebase-tools
 * 15.23.0 resolves a command's project (`lib/command.js` `applyRC` and
 * `configstoreProject`, `lib/rc.js`, and the `configstore` package's path):
 *
 * - an explicit `--project` wins;
 * - else the `firebase use` active project: firebase-tools' configstore
 *   (`$XDG_CONFIG_HOME/configstore/firebase-tools.json`, else
 *   `~/.config/configstore/firebase-tools.json`) maps each project directory
 *   to an alias or project id under `activeProjects`, matched from the project
 *   directory up through its ancestors;
 * - a value that names a `.firebaserc` `projects` alias resolves to its id;
 * - else the only `.firebaserc` alias when there is exactly one, else
 *   `projects.default`.
 *
 * firebase-tools reads no environment variable to choose a command's project.
 * Pyric adds `PYRIC_PROJECT` and the `pyric.json` `project` after the
 * explicit option. Every test runs against a temporary HOME, so the user's
 * own configstore is never read.
 */
import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { firebaseToolsConfigstorePath, resolveFirebaseProject } from '../../src/cli/firebase-project.js';
import type { FirebaseRc } from '../../src/cli/firebase-json.js';

function home(activeProjects?: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'pyric-project-home-'));
  if (activeProjects !== undefined) {
    mkdirSync(join(dir, '.config', 'configstore'), { recursive: true });
    writeFileSync(join(dir, '.config', 'configstore', 'firebase-tools.json'), JSON.stringify({ activeProjects }));
  }
  return dir;
}

function projectDir(rc?: FirebaseRc): string {
  const dir = mkdtempSync(join(tmpdir(), 'pyric-project-dir-'));
  if (rc !== undefined) writeFileSync(join(dir, '.firebaserc'), JSON.stringify(rc));
  return dir;
}

const RC: FirebaseRc = { projects: { default: 'rc-default', staging: 'staging-id', prod: 'prod-id' } };

describe('resolveFirebaseProject', () => {
  test('an explicit option wins over every other source', () => {
    const dir = projectDir(RC);
    const env = { HOME: home({ [dir]: 'staging' }), PYRIC_PROJECT: 'env-id' };
    expect(resolveFirebaseProject({ projectDir: dir, option: 'option-id', configProject: 'config-id', env }))
      .toEqual({ projectId: 'option-id', source: 'option' });
  });

  test('PYRIC_PROJECT follows the explicit option', () => {
    const dir = projectDir(RC);
    const env = { HOME: home({ [dir]: 'staging' }), PYRIC_PROJECT: 'env-id' };
    expect(resolveFirebaseProject({ projectDir: dir, configProject: 'config-id', env }))
      .toEqual({ projectId: 'env-id', source: 'PYRIC_PROJECT' });
  });

  test('the pyric.json project follows PYRIC_PROJECT', () => {
    const dir = projectDir(RC);
    const env = { HOME: home({ [dir]: 'staging' }) };
    expect(resolveFirebaseProject({ projectDir: dir, configProject: 'config-id', env }))
      .toEqual({ projectId: 'config-id', source: 'pyric-config' });
  });

  test('ignores the variables firebase-tools does not read to choose a project', () => {
    const dir = projectDir();
    const env = { HOME: home(), FIREBASE_PROJECT: 'a', GCLOUD_PROJECT: 'b', GOOGLE_CLOUD_PROJECT: 'c' };
    expect(resolveFirebaseProject({ projectDir: dir, env })).toEqual({});
  });

  test('the firebase use active project for the directory beats .firebaserc projects.default', () => {
    const dir = projectDir(RC);
    const env = { HOME: home({ [dir]: 'staging' }) };
    expect(resolveFirebaseProject({ projectDir: dir, env }))
      .toEqual({ projectId: 'staging-id', source: 'firebase-use', alias: 'staging' });
  });

  test('the active project of an ancestor directory applies, as firebase-tools walks up', () => {
    const parent = projectDir(RC);
    const child = join(parent, 'web');
    mkdirSync(child);
    writeFileSync(join(child, '.firebaserc'), JSON.stringify(RC));
    const env = { HOME: home({ [parent]: 'prod-id' }) };
    expect(resolveFirebaseProject({ projectDir: child, env }))
      .toEqual({ projectId: 'prod-id', source: 'firebase-use' });
  });

  test('the configstore under XDG_CONFIG_HOME is read when it is set', () => {
    const dir = projectDir(RC);
    const xdg = mkdtempSync(join(tmpdir(), 'pyric-project-xdg-'));
    mkdirSync(join(xdg, 'configstore'));
    writeFileSync(join(xdg, 'configstore', 'firebase-tools.json'), JSON.stringify({ activeProjects: { [dir]: 'prod' } }));
    const env = { HOME: home({ [dir]: 'staging' }), XDG_CONFIG_HOME: xdg };
    expect(firebaseToolsConfigstorePath(env)).toBe(join(xdg, 'configstore', 'firebase-tools.json'));
    expect(resolveFirebaseProject({ projectDir: dir, env }))
      .toEqual({ projectId: 'prod-id', source: 'firebase-use', alias: 'prod' });
  });

  test('.firebaserc projects.default applies without another source', () => {
    const dir = projectDir(RC);
    expect(resolveFirebaseProject({ projectDir: dir, env: { HOME: home() } }))
      .toEqual({ projectId: 'rc-default', source: 'firebaserc', alias: 'default' });
  });

  test('the only .firebaserc alias applies, as firebase-tools uses a sole alias', () => {
    const dir = projectDir({ projects: { prod: 'prod-id' } });
    expect(resolveFirebaseProject({ projectDir: dir, env: { HOME: home() } }))
      .toEqual({ projectId: 'prod-id', source: 'firebaserc', alias: 'prod' });
  });

  test('an alias from any source resolves to its project id', () => {
    const dir = projectDir(RC);
    const env = { HOME: home() };
    expect(resolveFirebaseProject({ projectDir: dir, option: 'prod', env }))
      .toEqual({ projectId: 'prod-id', source: 'option', alias: 'prod' });
    expect(resolveFirebaseProject({ projectDir: dir, env: { ...env, PYRIC_PROJECT: 'staging' } }))
      .toEqual({ projectId: 'staging-id', source: 'PYRIC_PROJECT', alias: 'staging' });
  });

  test('resolves nothing without any source', () => {
    expect(resolveFirebaseProject({ projectDir: projectDir(), env: { HOME: home() } })).toEqual({});
  });

  test('an unreadable configstore is skipped', () => {
    const dir = projectDir(RC);
    const badHome = home();
    mkdirSync(join(badHome, '.config', 'configstore'), { recursive: true });
    writeFileSync(join(badHome, '.config', 'configstore', 'firebase-tools.json'), '{not json');
    expect(resolveFirebaseProject({ projectDir: dir, env: { HOME: badHome } }).projectId).toBe('rc-default');
  });
});

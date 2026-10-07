/**
 * `firebase.json` `database`, read as firebase-tools 15.23.0 reads it for
 * `firebase deploy` (`lib/database/rulesConfig.js` `getRulesConfig`, and
 * `lib/deploy/database/prepare.js` for the rules file format):
 *
 * - a single object's `rules` deploys to `<projectId>-default-rtdb`;
 * - an array entry's `rules` deploys to its `instance`, or to every instance
 *   `.firebaserc` maps its `target` to; `target` wins over `instance`;
 * - an entry with neither throws `Must supply either "target" or "instance"
 *   in database config`, and an unmapped target throws `Deploy target <name>
 *   not configured for project <id>`;
 * - entries without `rules` deploy nothing.
 */
import { describe, expect, test } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { databaseRulesTargets, loadProjectDatabaseRules } from '../../src/serve/rules.js';
import type { FirebaseJson, FirebaseRc } from '../../src/cli/firebase-json.js';

const FIRST_RULES = { rules: { first: { '.read': true } } };
const SECOND_RULES = { rules: { second: { '.read': true } } };

function project(rc?: FirebaseRc): string {
  const dir = mkdtempSync(join(tmpdir(), 'pyric-database-instances-'));
  writeFileSync(join(dir, 'first.rules.json'), JSON.stringify(FIRST_RULES));
  writeFileSync(join(dir, 'second.rules.json'), JSON.stringify(SECOND_RULES));
  if (rc !== undefined) writeFileSync(join(dir, '.firebaserc'), JSON.stringify(rc));
  return dir;
}

function config(database: unknown): FirebaseJson {
  return { database } as FirebaseJson;
}

describe('firebase.json database: single object', () => {
  test('deploys its rules to the project default instance', async () => {
    const dir = project();
    const loaded = await loadProjectDatabaseRules(dir, config({ rules: 'first.rules.json' }), { projectId: 'demo' });
    expect(loaded.defaultInstance).toBe('demo-default-rtdb');
    expect([...loaded.instances.keys()]).toEqual(['demo-default-rtdb']);
    expect(loaded.instances.get('demo-default-rtdb')?.rules).toEqual(FIRST_RULES);
    expect(loaded.instances.get('demo-default-rtdb')?.sourcePath).toBe(join(dir, 'first.rules.json'));
  });

  test('takes the project id from .firebaserc projects.default when none is given', async () => {
    const dir = project({ projects: { default: 'from-rc' } });
    const loaded = await loadProjectDatabaseRules(dir, config({ rules: 'first.rules.json' }));
    expect(loaded.defaultInstance).toBe('from-rc-default-rtdb');
    expect(loaded.instances.get('from-rc-default-rtdb')?.rules).toEqual(FIRST_RULES);
  });

  test('without rules deploys nothing', () => {
    const dir = project();
    expect(databaseRulesTargets(dir, config({}), { projectId: 'demo' }).targets).toEqual([]);
  });

  test('without a database key loads database.rules.json into the default instance when it exists', async () => {
    const dir = project();
    const targets = databaseRulesTargets(dir, {}, { projectId: 'demo' });
    expect(targets.targets).toEqual([
      { instance: 'demo-default-rtdb', path: join(dir, 'database.rules.json'), configured: false },
    ]);
    const loaded = await loadProjectDatabaseRules(dir, {}, { projectId: 'demo' });
    expect(loaded.instances.size).toBe(0);
    writeFileSync(join(dir, 'database.rules.json'), JSON.stringify(SECOND_RULES));
    const created = await loadProjectDatabaseRules(dir, {}, { projectId: 'demo' });
    expect(created.instances.get('demo-default-rtdb')?.rules).toEqual(SECOND_RULES);
  });
});

describe('firebase.json database: array of instances', () => {
  test('deploys each entry rules to its own instance', async () => {
    const dir = project();
    const loaded = await loadProjectDatabaseRules(dir, config([
      { instance: 'first-instance', rules: 'first.rules.json' },
      { instance: 'second-instance', rules: 'second.rules.json' },
    ]), { projectId: 'demo' });
    expect(loaded.defaultInstance).toBe('demo-default-rtdb');
    expect([...loaded.declared]).toEqual(['first-instance', 'second-instance']);
    expect(loaded.instances.get('first-instance')?.rules).toEqual(FIRST_RULES);
    expect(loaded.instances.get('second-instance')?.rules).toEqual(SECOND_RULES);
  });

  test('skips an entry without rules', () => {
    const dir = project();
    const { targets } = databaseRulesTargets(dir, config([
      { instance: 'first-instance', rules: 'first.rules.json' },
      { instance: 'no-rules' },
    ]), { projectId: 'demo' });
    expect(targets.map((target) => target.instance)).toEqual(['first-instance']);
  });

  test('throws the Firebase CLI error for an entry with neither instance nor target', () => {
    const dir = project();
    expect(() => databaseRulesTargets(dir, config([
      { instance: 'first-instance', rules: 'first.rules.json' },
      { rules: 'second.rules.json' },
    ]), { projectId: 'demo' })).toThrow('firebase.json database[1]: Must supply either "target" or "instance" in database config');
  });

  test('throws for an entry with neither instance nor target even without rules', () => {
    const dir = project();
    expect(() => databaseRulesTargets(dir, config([{}]), { projectId: 'demo' }))
      .toThrow('Must supply either "target" or "instance" in database config');
  });

  test('refuses one instance named twice with different rules files', () => {
    const dir = project();
    expect(() => databaseRulesTargets(dir, config([
      { instance: 'shared', rules: 'first.rules.json' },
      { instance: 'shared', rules: 'second.rules.json' },
    ]), { projectId: 'demo' })).toThrow('database instance "shared"');
  });

  test('accepts one instance named twice with the same rules file', () => {
    const dir = project();
    const { targets } = databaseRulesTargets(dir, config([
      { instance: 'shared', rules: 'first.rules.json' },
      { instance: 'shared', rules: 'first.rules.json' },
    ]), { projectId: 'demo' });
    expect(targets).toEqual([{ instance: 'shared', path: join(dir, 'first.rules.json'), configured: true }]);
  });

  test('normalizes instance names as the SDK does and refuses a name that is not one', () => {
    const dir = project();
    const { targets } = databaseRulesTargets(dir, config([{ instance: 'Mixed-Case', rules: 'first.rules.json' }]), { projectId: 'demo' });
    expect(targets[0]?.instance).toBe('mixed-case');
    expect(() => databaseRulesTargets(dir, config([{ instance: 'not/a-name', rules: 'first.rules.json' }]), { projectId: 'demo' }))
      .toThrow('firebase.json database[0]: instance "not/a-name" is not a database instance name');
  });

  test('refuses a rules file that is not .json as the Firebase CLI does', () => {
    const dir = project();
    expect(() => databaseRulesTargets(dir, config([{ instance: 'a', rules: 'rules.bolt' }]), { projectId: 'demo' }))
      .toThrow('As of firebase-tools@15.0.0, .bolt rules are no longer supported.');
    expect(() => databaseRulesTargets(dir, config({ rules: 'rules.txt' }), { projectId: 'demo' }))
      .toThrow('Unexpected rules format .txt');
  });

  test('throws when a configured rules file does not exist, naming the instance and file', async () => {
    const dir = project();
    await expect(loadProjectDatabaseRules(dir, config([{ instance: 'gone', rules: 'missing.rules.json' }]), { projectId: 'demo' }))
      .rejects.toThrow(`database instance "gone": ${join(dir, 'missing.rules.json')} does not exist`);
  });

  test('does not read a url key', () => {
    const dir = project();
    expect(() => databaseRulesTargets(dir, config([
      { url: 'https://second-instance.firebaseio.com', rules: 'second.rules.json' },
    ]), { projectId: 'demo' })).toThrow('Must supply either "target" or "instance" in database config');
  });
});

describe('firebase.json database: deploy targets', () => {
  const rc: FirebaseRc = {
    projects: { default: 'demo' },
    targets: { demo: { database: { main: ['main-a', 'main-b'], solo: ['solo-db'] } } },
  };

  test('deploys a target entry rules to every instance .firebaserc maps it to', async () => {
    const dir = project(rc);
    const loaded = await loadProjectDatabaseRules(dir, config([
      { target: 'main', rules: 'first.rules.json' },
      { target: 'solo', rules: 'second.rules.json' },
    ]), { projectId: 'demo' });
    expect([...loaded.declared]).toEqual(['main-a', 'main-b', 'solo-db']);
    expect(loaded.instances.get('main-a')?.rules).toEqual(FIRST_RULES);
    expect(loaded.instances.get('main-b')?.rules).toEqual(FIRST_RULES);
    expect(loaded.instances.get('solo-db')?.rules).toEqual(SECOND_RULES);
  });

  test('target wins over instance in the same entry', () => {
    const dir = project(rc);
    const { targets } = databaseRulesTargets(dir, config([
      { target: 'solo', instance: 'ignored', rules: 'first.rules.json' },
    ]), { projectId: 'demo' });
    expect(targets.map((target) => target.instance)).toEqual(['solo-db']);
  });

  test('throws the Firebase CLI error for a target .firebaserc does not map', () => {
    const dir = project(rc);
    expect(() => databaseRulesTargets(dir, config([{ target: 'absent', rules: 'first.rules.json' }]), { projectId: 'demo' }))
      .toThrow('Deploy target absent not configured for project demo. Configure with:\n\n  firebase target:apply database absent <resources...>');
  });

  test('throws for a target when no project id is known', () => {
    const dir = project({ targets: rc.targets });
    expect(() => databaseRulesTargets(dir, config([{ target: 'main', rules: 'first.rules.json' }])))
      .toThrow('firebase.json database[0]: target "main" resolves through .firebaserc for a project, and no project id is set');
  });
});

describe('firebase.json database: load-time check per instance', () => {
  test('a ruleset production would refuse names its instance and file', async () => {
    const dir = project();
    writeFileSync(join(dir, 'refused.rules.json'), JSON.stringify({ rules: { '.read': 'newData.exists()' } }));
    const failure = await loadProjectDatabaseRules(dir, config([
      { instance: 'good', rules: 'first.rules.json' },
      { instance: 'refused', rules: 'refused.rules.json' },
    ]), { projectId: 'demo' }).then(() => null, (error: Error) => error);
    expect(failure?.message).toContain(`database instance "refused": ${join(dir, 'refused.rules.json')} is not valid RTDB rules.`);
    expect(failure?.message).toContain('/.read:');
    expect(failure?.message).not.toContain('"good"');
  });
});

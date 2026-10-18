/**
 * `firebase.json` `database` entries that name the default instance by its
 * legacy name, the project id (#1062). `firebase deploy` sends a legacy
 * project's default rules to `<projectId>`; Pyric deploys them to the default
 * instance, under the one name every per-instance structure keys it by.
 */
import { describe, expect, test } from 'bun:test';
import { databaseRulesConfig } from '../../../src/sandbox/internal/database-rules-config.js';

const PROJECT = 'legacy-config';

describe('databaseRulesConfig with the legacy default instance name', () => {
  test('an array entry for <projectId> deploys to the default instance', () => {
    const config = databaseRulesConfig([{ instance: PROJECT, rules: 'database.rules.json' }], { projectId: PROJECT });
    expect(config.defaultInstance).toBe(`${PROJECT}-default-rtdb`);
    expect(config.targets.map((target) => target.instance)).toEqual([config.defaultInstance]);
  });

  test('a deploy target .firebaserc maps to <projectId> deploys to the default instance', () => {
    const config = databaseRulesConfig([{ target: 'main', rules: 'database.rules.json' }], {
      projectId: PROJECT,
      targetInstances: (target) => (target === 'main' ? [PROJECT] : undefined),
    });
    expect(config.targets.map((target) => target.instance)).toEqual([config.defaultInstance]);
  });

  test('entries for both names with one rules file are one deploy to the default instance', () => {
    const config = databaseRulesConfig([
      { instance: PROJECT, rules: 'database.rules.json' },
      { instance: `${PROJECT}-default-rtdb`, rules: 'database.rules.json' },
    ], { projectId: PROJECT });
    expect(config.targets.map((target) => target.instance)).toEqual([config.defaultInstance]);
  });

  test('entries for both names with different rules files are refused, as two files for one instance', () => {
    expect(() => databaseRulesConfig([
      { instance: PROJECT, rules: 'legacy.rules.json' },
      { instance: `${PROJECT}-default-rtdb`, rules: 'database.rules.json' },
    ], { projectId: PROJECT })).toThrow(`firebase.json deploys two rules files to database instance "${PROJECT}-default-rtdb"`);
  });

  test('another instance keeps its name', () => {
    const config = databaseRulesConfig([
      { instance: PROJECT, rules: 'database.rules.json' },
      { instance: `${PROJECT}-shard-1`, rules: 'shard.rules.json' },
    ], { projectId: PROJECT });
    expect(config.targets.map((target) => target.instance)).toEqual([config.defaultInstance, `${PROJECT}-shard-1`]);
  });

  test('without a project id, an entry for a name keeps that name', () => {
    const config = databaseRulesConfig([{ instance: PROJECT, rules: 'database.rules.json' }]);
    expect(config.targets.map((target) => target.instance)).toEqual([PROJECT]);
  });
});

/**
 * `firebase.json` `database` as an array. Production deploys each entry's
 * `rules` file to the database named by that entry's `instance` key. The dev
 * server loads one ruleset: the first entry with `rules`. It does not read
 * `instance`, and it reads the database URL from a `url` key that production
 * does not define.
 */
import { describe, expect, test } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { databaseRulesPath, loadProjectDatabaseRules } from '../../src/serve/rules.js';
import type { FirebaseJson } from '../../src/cli/firebase-json.js';

const FIRST_RULES = { rules: { first: { '.read': true } } };
const SECOND_RULES = { rules: { second: { '.read': true } } };

function project(): string {
  const dir = mkdtempSync(join(tmpdir(), 'pyric-database-instances-'));
  writeFileSync(join(dir, 'first.rules.json'), JSON.stringify(FIRST_RULES));
  writeFileSync(join(dir, 'second.rules.json'), JSON.stringify(SECOND_RULES));
  return dir;
}

describe('firebase.json database array', () => {
  test('loads only the first entry with rules and ignores instance', async () => {
    const dir = project();
    const config = {
      database: [
        { instance: 'first-instance', rules: 'first.rules.json' },
        { instance: 'second-instance', rules: 'second.rules.json' },
      ],
    } as unknown as FirebaseJson;

    expect(databaseRulesPath(dir, config)).toBe(join(dir, 'first.rules.json'));
    const loaded = await loadProjectDatabaseRules(dir, config);
    expect(loaded.rules).toEqual(FIRST_RULES);
    expect(loaded.databaseUrl).toBeNull();
  });

  test('reads the database URL from a url key, not from instance', async () => {
    const dir = project();
    const config = {
      database: [
        { instance: 'first-instance', rules: 'first.rules.json' },
        { url: 'https://second-instance.firebaseio.com', rules: 'second.rules.json' },
      ],
    } as unknown as FirebaseJson;

    const loaded = await loadProjectDatabaseRules(dir, config);
    expect(loaded.rules).toEqual(FIRST_RULES);
    expect(loaded.databaseUrl).toBe('https://second-instance.firebaseio.com');
  });
});

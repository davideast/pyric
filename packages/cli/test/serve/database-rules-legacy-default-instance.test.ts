/**
 * The served in-page sandbox: an app whose `databaseURL` is the legacy
 * `https://<projectId>.firebaseio.com` registers the default instance, so
 * firebase.json's default rules reach it and no locked instance is created
 * for the project id (#1062).
 */
import { describe, expect, test } from 'bun:test';
import { initializeSandbox } from 'pyric/sandbox';
import { createAppForSandbox } from 'pyric/app/internal';
import { getDatabase, ref, set } from 'pyric/database';
import { heldDatabaseInstances } from 'pyric/database/internal';
import { createDatabaseRulesDeployment } from '../../src/serve/entries/database-rules.js';

const PROJECT = 'legacy-served';
const LEGACY_URL = `https://${PROJECT}.firebaseio.com`;
const DEFAULT_RULES = {
  rules: {
    open: { '.read': true, '.write': true },
    closed: { '.read': false, '.write': false },
  },
};

/** Run `body`, returning the Pyric RTDB notices it warned. */
async function warnings(body: () => Promise<void>): Promise<string[]> {
  const lines: string[] = [];
  const warn = console.warn;
  console.warn = (...args: unknown[]) => { lines.push(args.map(String).join(' ')); };
  try {
    await body();
  } finally {
    console.warn = warn;
  }
  return lines.filter((line) => line.startsWith('pyric: RTDB'));
}

describe('served in-page database rules with a legacy databaseURL', () => {
  for (const [label, deployed] of [
    ['a single database object', { defaultInstance: '(default)', rules: { '(default)': DEFAULT_RULES } }],
    ['an array entry for <projectId> with .firebaserc', { defaultInstance: `${PROJECT}-default-rtdb`, rules: { [`${PROJECT}-default-rtdb`]: DEFAULT_RULES } }],
    ['an array entry for <projectId> without .firebaserc', { defaultInstance: '(default)', rules: { [PROJECT]: DEFAULT_RULES } }],
  ] as const) {
    test(`the app gets the default rules from ${label}`, async () => {
      const sandbox = initializeSandbox();
      const deployment = createDatabaseRulesDeployment(sandbox);
      deployment.deploy(deployed);
      const warned = await warnings(async () => {
        deployment.register(LEGACY_URL, PROJECT);
        const app = createAppForSandbox(sandbox, { projectId: PROJECT, databaseURL: LEGACY_URL }, `${PROJECT}-${Math.random()}`);
        const db = getDatabase(app);
        await set(ref(db, 'open/a'), 1);
        await expect(set(ref(db, 'closed/a'), 1)).rejects.toThrow('PERMISSION_DENIED');
      });
      expect(warned).toEqual([]);
      expect(heldDatabaseInstances(sandbox)).not.toContain(PROJECT);
      expect(deployment.defaultName()).toBe(`${PROJECT}-default-rtdb`);
    });
  }

  test('different rules for both names learned late lock the default instance and name both files', async () => {
    const sandbox = initializeSandbox();
    const deployment = createDatabaseRulesDeployment(sandbox);
    deployment.deploy({
      defaultInstance: '(default)',
      rules: { [`${PROJECT}-default-rtdb`]: DEFAULT_RULES, [PROJECT]: { rules: { '.read': true, '.write': true } } },
      rulesFiles: { [`${PROJECT}-default-rtdb`]: 'database.rules.json', [PROJECT]: 'legacy.rules.json' },
    });
    const errors: string[] = [];
    const error = console.error;
    console.error = (...args: unknown[]) => { errors.push(args.map(String).join(' ')); };
    try {
      deployment.register(LEGACY_URL, PROJECT);
    } finally {
      console.error = error;
    }
    expect(errors).toEqual([
      `[pyric sandbox] firebase.json deploys two rules files to database instance "${PROJECT}-default-rtdb": database.rules.json to "${PROJECT}-default-rtdb" and legacy.rules.json to "${PROJECT}", which both name the default instance of project "${PROJECT}". The Firebase CLI deploys both at once, so the configuration does not determine which one production keeps. Deploy one rules file to each instance. The default instance stays locked until then.`,
    ]);
    const app = createAppForSandbox(sandbox, { projectId: PROJECT, databaseURL: LEGACY_URL }, `${PROJECT}-${Math.random()}`);
    await expect(set(ref(getDatabase(app), 'open/a'), 1)).rejects.toThrow('PERMISSION_DENIED');
  });

  test('a database opened without a URL gets rules deployed to <projectId>', async () => {
    const sandbox = initializeSandbox();
    const deployment = createDatabaseRulesDeployment(sandbox);
    deployment.deploy({ defaultInstance: '(default)', rules: { [PROJECT]: DEFAULT_RULES } });
    deployment.register(undefined, PROJECT);
    const app = createAppForSandbox(sandbox, { projectId: PROJECT }, `${PROJECT}-${Math.random()}`);
    const db = getDatabase(app);
    await set(ref(db, 'open/a'), 1);
    await expect(set(ref(db, 'closed/a'), 1)).rejects.toThrow('PERMISSION_DENIED');
  });
});

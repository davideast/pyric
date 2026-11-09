import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadRuleSources } from '../../../src/assurance-surface/rules/rule-sources.js';

const tempDirs: string[] = [];

function createTempDir(prefix: string): string {
  const created = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(created);
  return created;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!;
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('loadRuleSources project containment and target resolution', () => {
  test('rejects relative traversal outside project root across firestore, database, and storage', () => {
    const workspace = createTempDir('rule-sources-escape-');
    const outsideDir = join(workspace, 'outside');
    const projectDir = join(workspace, 'project');
    mkdirSync(outsideDir, { recursive: true });
    mkdirSync(projectDir, { recursive: true });

    writeFileSync(join(outsideDir, 'external.rules'), "rules_version = '2';");
    writeFileSync(join(outsideDir, 'external.rules.json'), '{"rules":{".read":false}}');
    writeFileSync(join(outsideDir, 'external.storage.rules'), "rules_version = '2'; service firebase.storage {}");
    writeFileSync(
      join(projectDir, 'firebase.json'),
      JSON.stringify({
        firestore: { rules: '../outside/external.rules' },
        database: { rules: '../outside/external.rules.json' },
        storage: { rules: '../outside/external.storage.rules' },
      }),
    );

    const loaded = loadRuleSources(projectDir);
    expect(loaded.firestore).toEqual([]);
    expect(loaded.rtdb).toEqual([]);
    expect(loaded.storage).toEqual([]);
    expect(loaded.problems).toHaveLength(3);
    for (const problem of loaded.problems) {
      expect(problem).toContain('escapes project root');
    }
  });

  test('rejects rule files reached through a symlinked ancestor directory escaping project root', () => {
    const workspace = createTempDir('rule-sources-parent-sym-');
    const outsideDir = join(workspace, 'outside');
    const projectDir = join(workspace, 'project');
    mkdirSync(outsideDir, { recursive: true });
    mkdirSync(projectDir, { recursive: true });

    writeFileSync(join(outsideDir, 'external.rules'), "rules_version = '2';");
    writeFileSync(join(outsideDir, 'external.rules.json'), '{"rules":{".read":false}}');
    writeFileSync(join(outsideDir, 'external.storage.rules'), "rules_version = '2'; service firebase.storage {}");
    symlinkSync(outsideDir, join(projectDir, 'linked-rules'));

    writeFileSync(
      join(projectDir, 'firebase.json'),
      JSON.stringify({
        firestore: { rules: 'linked-rules/external.rules' },
        database: { rules: 'linked-rules/external.rules.json' },
        storage: { rules: 'linked-rules/external.storage.rules' },
      }),
    );

    const loaded = loadRuleSources(projectDir);
    expect(loaded.firestore).toEqual([]);
    expect(loaded.rtdb).toEqual([]);
    expect(loaded.storage).toEqual([]);
    expect(loaded.problems).toHaveLength(3);
    for (const problem of loaded.problems) {
      expect(problem).toContain('escapes project root');
    }
  });

  test('resolves .firebaserc targets for firestore, database, and storage', () => {
    const projectDir = createTempDir('rule-sources-targets-');
    writeFileSync(
      join(projectDir, '.firebaserc'),
      JSON.stringify({
        projects: { default: 'proj-alpha' },
        targets: {
          'proj-alpha': {
            firestore: {
              primaryDb: ['(default)'],
              auditDb: ['db-audit'],
            },
            database: {
              primaryRtdb: ['proj-alpha-default-rtdb'],
              secondaryRtdb: ['inst-secondary'],
            },
            storage: {
              secondaryBucket: ['bucket-secondary'],
            },
          },
        },
      }),
    );
    writeFileSync(
      join(projectDir, 'firebase.json'),
      JSON.stringify({
        firestore: [
          { target: 'primaryDb', rules: 'firestore.rules' },
          { target: 'auditDb', rules: 'audit.firestore.rules' },
        ],
        database: [
          { target: 'primaryRtdb', rules: 'database.rules.json' },
          { target: 'secondaryRtdb', rules: 'secondary.rules.json' },
        ],
        storage: [
          { target: 'secondaryBucket', rules: 'secondary.storage.rules' },
        ],
      }),
    );
    writeFileSync(join(projectDir, 'firestore.rules'), "rules_version = '2'; // default");
    writeFileSync(join(projectDir, 'audit.firestore.rules'), "rules_version = '2'; // audit");
    writeFileSync(join(projectDir, 'database.rules.json'), '{"rules":{".read":false}}');
    writeFileSync(join(projectDir, 'secondary.rules.json'), '{"rules":{"items":{".read":"auth != null"}}}');
    writeFileSync(
      join(projectDir, 'secondary.storage.rules'),
      "rules_version = '2'; service firebase.storage {}",
    );

    const loaded = loadRuleSources(projectDir);
    expect(loaded.problems).toEqual([]);
    expect(loaded.firestore).toEqual([
      { source: 'firestore.rules', text: "rules_version = '2'; // default" },
      { source: 'audit.firestore.rules', database: 'db-audit', text: "rules_version = '2'; // audit" },
    ]);
    expect(loaded.rtdb).toEqual([
      { source: 'database.rules.json', json: { rules: { '.read': false } } },
      {
        source: 'secondary.rules.json',
        instance: 'inst-secondary',
        json: { rules: { items: { '.read': 'auth != null' } } },
      },
    ]);
    expect(loaded.storage).toEqual([
      {
        source: 'secondary.storage.rules',
        bucket: 'bucket-secondary',
        text: "rules_version = '2'; service firebase.storage {}",
      },
    ]);
  });
});

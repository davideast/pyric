import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadRuleSources, parseRtdbRulesText } from '../../../src/assurance-surface/rules/rule-sources.js';

const dir = mkdtempSync(join(tmpdir(), 'rule-sources-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('loadRuleSources', () => {
  test('reads firebase.json targets once each, with comments in RTDB rules', () => {
    writeFileSync(join(dir, 'firebase.json'), JSON.stringify({
      firestore: { rules: 'firestore.rules' },
      database: [{ target: 'a', rules: 'db.rules.json' }, { target: 'b', rules: 'db.rules.json' }],
    }));
    writeFileSync(join(dir, 'firestore.rules'), "rules_version = '2';");
    writeFileSync(join(dir, 'db.rules.json'), '{\n  // generated\n  "rules": { ".read": true, },\n}');
    const s = loadRuleSources(dir);
    expect(s.firestore.map((f) => f.source)).toEqual(['firestore.rules']);
    expect(s.rtdb).toEqual([{ source: 'db.rules.json', json: { rules: { '.read': true } } }]);
    expect(s.problems).toEqual([]);
  });

  test('explicit files win and suppress firebase.json discovery for unspecified services', () => {
    const customRtdb = join(dir, 'custom.rules.json');
    writeFileSync(customRtdb, JSON.stringify({ rules: { items: { '.read': 'auth != null' } } }));
    const s = loadRuleSources(dir, { rtdb: [customRtdb] });
    expect(s.firestore).toEqual([]);
    expect(s.rtdb.map((r) => r.source)).toEqual(['custom.rules.json']);

    const missing = loadRuleSources(dir, { rtdb: [join(dir, 'missing.json')] });
    expect(missing.firestore).toEqual([]);
    expect(missing.rtdb).toEqual([]);
    expect(missing.problems[0]).toContain('missing.json');
  });

  test('parseRtdbRulesText accepts trailing commas', () => {
    expect(parseRtdbRulesText('{"rules":{"a":{".write":"auth != null",},},}')).toEqual({ rules: { a: { '.write': 'auth != null' } } });
  });

  test('loads single and per-bucket storage rule entries from firebase.json', () => {
    const stDir = mkdtempSync(join(tmpdir(), 'rule-sources-storage-'));
    try {
      writeFileSync(
        join(stDir, 'firebase.json'),
        JSON.stringify({
          storage: [
            { rules: 'storage.rules' },
            { bucket: 'media-bucket', rules: 'media.storage.rules' },
          ],
        }),
      );
      writeFileSync(join(stDir, 'storage.rules'), "rules_version = '2'; service firebase.storage {}");
      writeFileSync(join(stDir, 'media.storage.rules'), "rules_version = '2'; service firebase.storage {}");
      const loaded = loadRuleSources(stDir);
      expect(loaded.storage).toEqual([
        { source: 'storage.rules', text: "rules_version = '2'; service firebase.storage {}" },
        {
          source: 'media.storage.rules',
          bucket: 'media-bucket',
          text: "rules_version = '2'; service firebase.storage {}",
        },
      ]);
    } finally {
      rmSync(stDir, { recursive: true, force: true });
    }
  });

  test('refuses symbolic links for rule files', () => {
    const symDir = mkdtempSync(join(tmpdir(), 'rule-sources-symlink-'));
    try {
      const realTarget = join(symDir, 'outside.rules');
      writeFileSync(realTarget, "rules_version = '2';");
      const linked = join(symDir, 'firestore.rules');
      symlinkSync(realTarget, linked);
      writeFileSync(
        join(symDir, 'firebase.json'),
        JSON.stringify({ firestore: { rules: 'firestore.rules' } }),
      );
      const loaded = loadRuleSources(symDir);
      expect(loaded.firestore).toEqual([]);
      expect(loaded.problems[0]).toContain('Symbolic links are not followed');
    } finally {
      rmSync(symDir, { recursive: true, force: true });
    }
  });

  test('loads per-database Firestore and per-instance RTDB rule entries from firebase.json', () => {
    const multiDir = mkdtempSync(join(tmpdir(), 'rule-sources-multi-'));
    try {
      writeFileSync(
        join(multiDir, 'firebase.json'),
        JSON.stringify({
          firestore: [
            { rules: 'firestore.rules' },
            { database: 'analytics', rules: 'analytics.firestore.rules' },
          ],
          database: [
            { rules: 'database.rules.json' },
            { instance: 'shard-a', rules: 'shard-a.rules.json' },
          ],
        }),
      );
      writeFileSync(join(multiDir, 'firestore.rules'), "rules_version = '2';");
      writeFileSync(join(multiDir, 'analytics.firestore.rules'), "rules_version = '2'; // analytics");
      writeFileSync(join(multiDir, 'database.rules.json'), '{"rules":{".read":false}}');
      writeFileSync(join(multiDir, 'shard-a.rules.json'), '{"rules":{"metrics":{".read":"auth != null"}}}');

      const loaded = loadRuleSources(multiDir);
      expect(loaded.firestore).toEqual([
        { source: 'firestore.rules', text: "rules_version = '2';" },
        {
          source: 'analytics.firestore.rules',
          database: 'analytics',
          text: "rules_version = '2'; // analytics",
        },
      ]);
      expect(loaded.rtdb).toEqual([
        { source: 'database.rules.json', json: { rules: { '.read': false } } },
        {
          source: 'shard-a.rules.json',
          instance: 'shard-a',
          json: { rules: { metrics: { '.read': 'auth != null' } } },
        },
      ]);
    } finally {
      rmSync(multiDir, { recursive: true, force: true });
    }
  });
});

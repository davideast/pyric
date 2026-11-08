import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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
});

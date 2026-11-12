import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { renderRtdbCoverage, rtdbRules } from '../../src/index.js';

describe('rtdbRules(rulesText) coverage source lines', () => {
  test('retains input rules text so simulate().coverage and renderRtdbCoverage include line numbers matching fromFirebaseJson', () => {
    const rulesText = [
      '// Realtime Database rules with comment header',
      '{',
      '  "rules": {',
      '    "items": {',
      '      ".read": "auth != null",',
      '      ".write": false',
      '    }',
      '  }',
      '}',
      '',
    ].join('\n');

    const dir = mkdtempSync(join(tmpdir(), 'rtdb-text-cov-'));
    try {
      writeFileSync(join(dir, 'database.rules.json'), rulesText);
      writeFileSync(join(dir, 'firebase.json'), JSON.stringify({ database: { rules: 'database.rules.json' } }));
      writeFileSync(join(dir, '.firebaserc'), JSON.stringify({ projects: { default: 'demo-proj' } }));

      const cases = [{ expectation: 'ALLOW' as const, operation: 'read' as const, path: '/items', auth: 'u1' }];
      const directRendered = renderRtdbCoverage(rtdbRules(rulesText).simulate(cases).coverage);
      const fromFbRendered = renderRtdbCoverage(
        rtdbRules.fromFirebaseJson(join(dir, 'firebase.json')).simulate(cases).coverage,
      );

      expect(fromFbRendered).toContain('(line 5)');
      expect(fromFbRendered).toContain('(line 6)');
      expect(directRendered).toContain('(line 5)');
      expect(directRendered).toContain('(line 6)');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

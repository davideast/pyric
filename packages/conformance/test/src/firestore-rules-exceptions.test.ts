import { describe, expect, it } from 'bun:test';
import { loadFirestoreRulesExceptions } from '../../src/firestore-rules-exceptions.ts';

const VERDICTS = ['ALLOW', 'DENY'];

describe('Firestore Rules exception index', () => {
  const exceptions = [...loadFirestoreRulesExceptions()];

  it('names every pin by observation and case', () => {
    for (const [key] of exceptions) {
      expect(key).toMatch(/^rules-firestore-[a-z0-9-]+ :: .+$/);
    }
  });

  it('pins two different verdicts on a Firestore Rules row with a reason and an issue', () => {
    for (const [key, record] of exceptions) {
      expect(record.rowId, key).toMatch(/^firestore-rules#\d+$/);
      expect(VERDICTS, key).toContain(record.productionVerdict);
      expect(VERDICTS, key).toContain(record.simulatorVerdict);
      expect(record.simulatorVerdict, key).not.toBe(record.productionVerdict);
      expect(record.reason.length, key).toBeGreaterThan(0);
      expect(record.issue.length, key).toBeGreaterThan(0);
    }
  });
});

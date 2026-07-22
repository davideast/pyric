import { describe, expect, it } from 'bun:test';
import { requireExactProbeResults } from '../../src/rules-language-acceptance.ts';

describe('rules-language production acceptance evidence', () => {
  it('fails closed when the Rules Test API omits a result row', () => {
    expect(() => requireExactProbeResults('firestore', 'firestore.operator.eq', 1, [])).toThrow(
      'expected 1, got 0',
    );
  });

  it('fails closed when the Rules Test API duplicates a result row', () => {
    expect(() => requireExactProbeResults('firestore', 'firestore.operator.eq', 1, [{}, {}])).toThrow(
      'expected 1, got 2',
    );
  });
});

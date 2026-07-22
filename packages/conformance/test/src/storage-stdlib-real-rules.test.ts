import { describe, expect, test } from 'bun:test';
import {
  injectIntoMatch,
  rulesLiteral,
} from '../../src/storage-stdlib-real-rules.ts';

describe('storage stdlib real Rules source support', () => {
  test('Rules literals escape quotes, slashes, and Unicode without interpolation', () => {
    expect(rulesLiteral('a"b\\c雪')).toBe('"a\\"b\\\\c雪"');
  });

  test('source injection fails closed when the canonical match is absent', () => {
    const pattern = /(match\s+\/b\/\{bucket\}\/o\s*\{)/;
    expect(injectIntoMatch(
      'service firebase.storage { match /b/{bucket}/o { } }',
      pattern,
      '`match /b/{bucket}/o`',
      '\nprobe\n',
    )).toContain('probe');
    expect(() => injectIntoMatch(
      'service firebase.storage {}',
      pattern,
      '`match /b/{bucket}/o`',
      '\nprobe\n',
    )).toThrow('current rules lack canonical');
  });
});

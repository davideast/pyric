import { describe, expect, test } from 'bun:test';
import {
  matchRtdbReference,
  normalizeRtdbReference,
  rtdbReferenceParamName,
  rtdbReferenceParts,
  supportsRtdbReference,
} from '../../src/functions-rtdb/reference-pattern.js';

describe('RTDB Eventarc reference patterns', () => {
  test('normalizes references and splits their segments once', () => {
    expect(normalizeRtdbReference('//messages/{id}//original/')).toBe(
      'messages/{id}/original',
    );
    expect(rtdbReferenceParts('//messages/{id}//original/')).toEqual([
      'messages',
      '{id}',
      'original',
    ]);
  });

  test('recognizes every admitted named single-segment capture', () => {
    expect(rtdbReferenceParamName('{_id}')).toBe('_id');
    expect(rtdbReferenceParamName('{123}')).toBe('123');
    expect(rtdbReferenceParamName('{id=*}')).toBe('id');
    expect(supportsRtdbReference('/messages/{_id}/{123}/{id=*}')).toBe(true);
  });

  test('rejects richer and anonymous wildcard patterns', () => {
    for (const reference of [
      '/messages/{id=prefix/*}',
      '/messages/{id=**}',
      '/messages/*',
      '/messages/prefix-*',
    ]) {
      expect(supportsRtdbReference(reference)).toBe(false);
    }
  });

  test('matches a concrete path against a pattern, capturing the wildcard segments', () => {
    expect(matchRtdbReference('messages/{pushId}/original', 'messages/abc123/original')).toEqual({
      pushId: 'abc123',
    });
    expect(matchRtdbReference('logs/{logId}', '/logs/xyz/')).toEqual({ logId: 'xyz' });
  });

  test('refuses a path whose literal segments or shape disagree with the pattern', () => {
    expect(matchRtdbReference('messages/{pushId}/original', 'messages/abc123/edited')).toBeNull();
    expect(matchRtdbReference('messages/{pushId}/original', 'messages/abc123')).toBeNull();
    expect(matchRtdbReference('messages/{pushId}', 'messages/abc/original')).toBeNull();
  });
});

/**
 * Matcher construction and display reduction for the `ai_logic` methods:
 * `matcherFor` builds the {@link ScriptMatcher} `script` pushes, and
 * `describeMatch`/`describeRespond` are what `scripts` reads back for
 * listing, including a model-tagged predicate this module built itself.
 */
import { describe, expect, it } from 'bun:test';

import {
  bareModel,
  describeMatch,
  describeRespond,
  matcherFor,
  respondFor,
} from '../../../src/bridge/surface/ai-logic-matchers.js';

const REQUEST = { contents: [{ role: 'user', parts: [{ text: 'archive status please' }] }] };

describe('bareModel', () => {
  it('strips a leading models/ prefix, leaving a bare name unchanged', () => {
    expect(bareModel('models/gemini-2.0-flash')).toBe('gemini-2.0-flash');
    expect(bareModel('gemini-2.0-flash')).toBe('gemini-2.0-flash');
  });
});

describe('matcherFor', () => {
  it('returns undefined for an unconditional match', () => {
    expect(matcherFor({})).toBeUndefined();
  });

  it('returns the plain substring for a substring-only match', () => {
    expect(matcherFor({ substring: 'archive status' })).toBe('archive status');
  });

  it('a model-only match is a predicate that reads the requested model, stripping models/', () => {
    const matcher = matcherFor({ model: 'gemini-2.0-flash' }) as (req: unknown, model?: string) => boolean;
    expect(matcher(REQUEST, 'models/gemini-2.0-flash')).toBe(true);
    expect(matcher(REQUEST, 'gemini-2.0-flash')).toBe(true);
    expect(matcher(REQUEST, 'gemini-flash-lite-latest')).toBe(false);
    expect(matcher(REQUEST, undefined)).toBe(false);
  });

  it('a combined match requires the substring and the model both', () => {
    const matcher = matcherFor({ substring: 'archive status', model: 'gemini-2.0-flash' }) as (
      req: unknown,
      model?: string,
    ) => boolean;
    expect(matcher(REQUEST, 'gemini-2.0-flash')).toBe(true);
    expect(matcher(REQUEST, 'gemini-flash-lite-latest')).toBe(false);
    expect(matcher({ contents: [{ role: 'user', parts: [{ text: 'weather' }] }] }, 'gemini-2.0-flash')).toBe(
      false,
    );
  });
});

describe('describeMatch', () => {
  it('reports undefined as null (unconditional)', () => {
    expect(describeMatch(undefined)).toBeNull();
  });

  it('reports a plain string as { substring }', () => {
    expect(describeMatch('archive status')).toEqual({ substring: 'archive status' });
  });

  it('reports a regexp as { pattern }', () => {
    expect(describeMatch(/archive/i)).toEqual({ pattern: 'archive' });
  });

  it('reports a matcherFor()-built predicate by its tagged descriptor', () => {
    const match = { substring: 'archive status', model: 'gemini-2.0-flash' };
    expect(describeMatch(matcherFor(match))).toEqual(match);
    expect(describeMatch(matcherFor({ model: 'gemini-2.0-flash' }))).toEqual({ model: 'gemini-2.0-flash' });
  });
});

describe('respondFor and describeRespond round trip', () => {
  it('text', () => {
    const respond = respondFor({ type: 'text', payload: 'hello' });
    expect(respond).toEqual({ text: 'hello' });
    expect(describeRespond(respond)).toEqual({ type: 'text', payload: 'hello' });
  });

  it('json', () => {
    const respond = respondFor({ type: 'json', payload: { a: 1 } });
    expect(respond).toEqual({ json: { a: 1 } });
    expect(describeRespond(respond)).toEqual({ type: 'json', payload: { a: 1 } });
  });

  it('error, defaulting status to INVALID_ARGUMENT and dropping it from the display', () => {
    const respond = respondFor({ type: 'error', payload: { code: 400, message: 'bad' } });
    expect(respond).toEqual({ error: { code: 400, message: 'bad', status: 'INVALID_ARGUMENT' } });
    expect(describeRespond(respond)).toEqual({ type: 'error', payload: { code: 400, message: 'bad' } });
  });
});

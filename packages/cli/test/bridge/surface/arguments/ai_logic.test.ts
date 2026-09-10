/**
 * The `ai_logic` tool's argument vocabulary: `match{substring?, model?}` and
 * `response{type, payload}`.
 */
import { describe, expect, it } from 'bun:test';

import {
  scriptMatchArgument,
  scriptResponseArgument,
} from '../../../../src/bridge/surface/arguments/ai_logic.js';

describe('scriptMatchArgument', () => {
  it('accepts neither field, one, or both', () => {
    expect(scriptMatchArgument.safeParse({}).success).toBe(true);
    expect(scriptMatchArgument.safeParse({ substring: 'weather' }).success).toBe(true);
    expect(scriptMatchArgument.safeParse({ model: 'gemini-2.0-flash' }).success).toBe(true);
    expect(
      scriptMatchArgument.safeParse({ substring: 'weather', model: 'gemini-2.0-flash' }).success,
    ).toBe(true);
  });

  it('refuses a non-string field', () => {
    expect(scriptMatchArgument.safeParse({ substring: 1 }).success).toBe(false);
    expect(scriptMatchArgument.safeParse({ model: 1 }).success).toBe(false);
  });
});

describe('scriptResponseArgument', () => {
  it('requires type as one of text, json, or error', () => {
    expect(scriptResponseArgument.safeParse({ type: 'text', payload: 'hi' }).success).toBe(true);
    expect(scriptResponseArgument.safeParse({ type: 'json', payload: { a: 1 } }).success).toBe(true);
    expect(
      scriptResponseArgument.safeParse({ type: 'error', payload: { code: 400, message: 'bad' } })
        .success,
    ).toBe(true);
    expect(scriptResponseArgument.safeParse({ type: 'other', payload: 'hi' }).success).toBe(false);
  });

  it('accepts a missing payload at the schema level, leaving the type/payload agreement to validate()', () => {
    expect(scriptResponseArgument.safeParse({ type: 'text' }).success).toBe(true);
  });
});

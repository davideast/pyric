import { describe, expect, it } from 'bun:test';
import { asSentence } from '../../../src/sandbox/internal/sentence.js';

describe('asSentence', () => {
  it('adds a period to text without a terminal mark', () => {
    expect(asSentence('condition false')).toBe('condition false.');
  });

  it('keeps a terminal mark the wrapped text already has', () => {
    expect(asSentence('Name: [bool].')).toBe('Name: [bool].');
    expect(asSentence('expected "}".')).toBe('expected "}".');
    expect(asSentence('stop!')).toBe('stop!');
    expect(asSentence('why?')).toBe('why?');
  });

  it('closes empty text as a period', () => {
    expect(asSentence('')).toBe('.');
  });
});

/**
 * The near-miss suggestion a rejection carries, and how a value is shown back.
 *
 * The budget scales with the longer of the two names rather than the input,
 * which is what lets a name lengthened by a whole word still find its target,
 * and what keeps two unrelated names from being suggested for each other.
 */
import { describe, expect, it } from 'bun:test';

import { closest, editDistance, quoted } from '../../../src/bridge/surface/closest-name.js';

const METHODS = ['getDoc', 'getDocs', 'setDoc', 'addDoc', 'updateDoc', 'deleteDoc'];

describe('editDistance', () => {
  it('is zero for identical strings', () => {
    expect(editDistance('setDoc', 'setDoc')).toBe(0);
  });

  it('counts one edit per substitution, insertion, and deletion', () => {
    expect(editDistance('setDoc', 'setDog')).toBe(1);
    expect(editDistance('setDoc', 'setDocs')).toBe(1);
    expect(editDistance('setDocs', 'setDoc')).toBe(1);
  });

  it('is the length of the other string when one is empty', () => {
    expect(editDistance('', 'setDoc')).toBe(6);
    expect(editDistance('setDoc', '')).toBe(6);
  });
});

describe('closest', () => {
  it('finds a typo', () => {
    expect(closest('setDco', METHODS)).toBe('setDoc');
  });

  it('finds a name lengthened by a whole word', () => {
    expect(closest('setDocument', METHODS)).toBe('setDoc');
  });

  it('ignores case, because a method name is chosen from a list', () => {
    expect(closest('SETDOC', METHODS)).toBe('setDoc');
  });

  it('names nothing when nothing is close enough to suggest', () => {
    expect(closest('subscribeToTopic', METHODS)).toBeNull();
  });

  it('names nothing when there are no candidates', () => {
    expect(closest('setDoc', [])).toBeNull();
  });
});

describe('quoted', () => {
  it('quotes a string as the caller wrote it', () => {
    expect(quoted('firestone')).toBe("'firestone'");
  });

  it('says missing rather than quoting nothing', () => {
    expect(quoted(undefined)).toBe('missing');
  });

  it('quotes any other value as the JSON it is', () => {
    expect(quoted(7)).toBe("'7'");
    expect(quoted({ uid: 'alice' })).toBe('\'{"uid":"alice"}\'');
  });
});

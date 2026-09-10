/**
 * The three words each method's name is built from: `spellName` joins them
 * and drops an empty one, and `wordsFor` reads every method's words, either
 * the canonical operation's own or the record's declared override.
 */
import { describe, expect, it } from 'bun:test';

import { spellName, wordsFor } from '../../../../src/bridge/surface/render/method-words.js';
import { METHODS } from '../../../../src/bridge/surface/methods/registry.js';

describe('spellName', () => {
  it('joins non-empty words with an underscore', () => {
    expect(spellName(['get', 'firestore', 'document'])).toBe('get_firestore_document');
  });

  it('drops an empty word rather than spelling a separator for it', () => {
    expect(spellName(['reset', 'sandbox', ''])).toBe('reset_sandbox');
  });
});

describe('wordsFor', () => {
  it('reads the declared override for a method whose words are not canonical', () => {
    expect(wordsFor('auth.impersonate')).toEqual({
      verb: 'impersonate',
      service: 'auth',
      object: 'user',
    });
    expect(wordsFor('firestore.getDocs')).toEqual({
      verb: 'read',
      service: 'firestore',
      object: 'collection',
    });
  });

  it('derives words from the canonical id for every other method', () => {
    expect(wordsFor('firestore.getDoc')).toEqual({
      verb: 'get',
      service: 'firestore',
      object: 'document',
    });
  });

  it('throws for a key no method carries', () => {
    expect(() => wordsFor('not.a.method')).toThrow("no name words for method 'not.a.method'");
  });

  it('gives every method its own name, none claimed twice', () => {
    const claimed = new Set<string>();
    for (const method of METHODS) {
      const words = wordsFor(method.key);
      const name = spellName([words.verb, words.service, words.object]);
      expect(claimed.has(name)).toBe(false);
      claimed.add(name);
    }
  });
});

/**
 * RulesState unit tests (ADR-0009, PR B3).
 *
 * Pins the holder's contract directly: source get/set, the RULES-B11
 * per-source AST cache (hit on identical source, invalidation on a new
 * source), and null-AST behavior for unparseable source.
 */
import { describe, test, expect } from 'bun:test';
import { RulesState } from '../../../src/firestore/sandbox/rules-state.js';

const OPEN_RULES = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /{document=**} {
      allow read, write: if true;
    }
  }
}`;

const CLOSED_RULES = OPEN_RULES.replace('if true', 'if false');

describe('RulesState', () => {
  test('holds the source it was constructed with', () => {
    const rules = new RulesState(OPEN_RULES);
    expect(rules.source).toBe(OPEN_RULES);
  });

  test('set() swaps the source', () => {
    const rules = new RulesState(OPEN_RULES);
    rules.set(CLOSED_RULES);
    expect(rules.source).toBe(CLOSED_RULES);
  });

  test('ast() parses and returns a non-null AST for valid rules', () => {
    const rules = new RulesState(OPEN_RULES);
    const ast = rules.ast();
    expect(ast).not.toBeNull();
  });

  test('ast() cache hit — same source returns the identical AST object', () => {
    const rules = new RulesState(OPEN_RULES);
    const first = rules.ast();
    const second = rules.ast();
    expect(second).toBe(first!);
  });

  test('ast() cache stays warm across set() with byte-identical source', () => {
    const rules = new RulesState(OPEN_RULES);
    const first = rules.ast();
    rules.set(OPEN_RULES);
    expect(rules.ast()).toBe(first!);
  });

  test('set() with new source invalidates the cache — fresh AST object', () => {
    const rules = new RulesState(OPEN_RULES);
    const first = rules.ast();
    rules.set(CLOSED_RULES);
    const second = rules.ast();
    expect(second).not.toBeNull();
    expect(second).not.toBe(first!);
    // And flipping back re-parses again (cache holds only one entry).
    rules.set(OPEN_RULES);
    expect(rules.ast()).not.toBe(first!);
  });

  test('ast() returns null for unparseable source (simulate() reports the failure)', () => {
    const rules = new RulesState('this is not a valid ruleset {{{');
    expect(rules.ast()).toBeNull();
    // Cached null — repeat calls stay null without throwing.
    expect(rules.ast()).toBeNull();
  });
});

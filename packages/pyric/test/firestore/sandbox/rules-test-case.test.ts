import { describe, expect, test } from 'bun:test';
import { LocalState } from '../../../src/firestore/sandbox/local-state.js';
import { buildRulesTestCase } from '../../../src/firestore/sandbox/rules-test-case.js';

describe('buildRulesTestCase', () => {
  test('projects set as create or update from the live pre-write state', () => {
    const state = new LocalState();

    expect(buildRulesTestCase(state, {
      method: 'set', path: 'notes/n1', auth: null, data: { value: 1 },
    }).method).toBe('create');

    state.set('notes/n1', { value: 0 });
    expect(buildRulesTestCase(state, {
      method: 'set', path: 'notes/n1', auth: null, data: { value: 1 },
    }).method).toBe('update');
  });

  test('merges update data into the rule-visible request resource', () => {
    const state = new LocalState({ 'notes/n1': { keep: true, value: 0 } });

    expect(buildRulesTestCase(state, {
      method: 'update', path: 'notes/n1', auth: null, data: { value: 1 },
    }).data).toEqual({ keep: true, value: 1 });
  });
});

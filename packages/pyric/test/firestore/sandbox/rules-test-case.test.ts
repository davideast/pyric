import { describe, expect, test } from 'bun:test';
import { LocalState } from '../../../src/firestore/sandbox/local-state.js';
import { buildRulesTestCase } from '../../../src/firestore/sandbox/rules-test-case.js';
import { DELETE_MARKER } from '../../../src/firestore/sandbox/value-resolver.js';

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

  test('applies a dotted update key as a nested field path', () => {
    const state = new LocalState({ 'games/g1': { lastMove: '', board: { c0r0: '', c1r1: '' } } });

    const data = buildRulesTestCase(state, {
      method: 'update', path: 'games/g1', auth: null, data: { 'board.c1r1': 'x', lastMove: 'c1r1' },
    }).data;

    expect(data).toEqual({ lastMove: 'c1r1', board: { c0r0: '', c1r1: 'x' } });
    expect(Object.keys(data ?? {})).not.toContain('board.c1r1');
  });

  test('removes the nested leaf for a dotted delete', () => {
    const state = new LocalState({ 'games/g1': { board: { c0r0: '', c1r1: 'o' } } });

    expect(buildRulesTestCase(state, {
      method: 'update', path: 'games/g1', auth: null, data: { 'board.c1r1': DELETE_MARKER },
    }).data).toEqual({ board: { c0r0: '' } });
  });

  test('deep-merges a nested map for a merge set', () => {
    const state = new LocalState({ 'games/g1': { board: { c0r0: '', c1r1: '' } } });

    expect(buildRulesTestCase(state, {
      method: 'update', path: 'games/g1', auth: null, merge: true, data: { board: { c1r1: 'x' } },
    }).data).toEqual({ board: { c0r0: '', c1r1: 'x' } });
  });

  test('writes only the listed field paths for a merge set with mergeFields', () => {
    const state = new LocalState({ 'games/g1': { board: { c0r0: '', c1r1: '' }, lastMove: '' } });

    expect(buildRulesTestCase(state, {
      method: 'update',
      path: 'games/g1',
      auth: null,
      merge: { mergeFields: ['board.c1r1'] },
      data: { board: { c0r0: 'o', c1r1: 'x' }, lastMove: 'c1r1' },
    }).data).toEqual({ board: { c0r0: '', c1r1: 'x' }, lastMove: '' });
  });

  test('never mutates the stored document', () => {
    const state = new LocalState({ 'games/g1': { board: { c0r0: '', c1r1: '' } } });

    buildRulesTestCase(state, {
      method: 'update', path: 'games/g1', auth: null, data: { 'board.c1r1': 'x' },
    });

    expect(state.get('games/g1')).toEqual({ board: { c0r0: '', c1r1: '' } });
  });
});

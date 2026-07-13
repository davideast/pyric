// Pending-prefix folder mechanism — pure reducer probes. The decision
// record lives in src/storage/pendingPrefixes.ts: created folders are
// client-side state until the first upload materializes them.
import { describe, it, expect } from 'bun:test';
import {
  expandPathChain,
  initialPendingPrefixes,
  pendingPrefixReducer,
  pendingChildFolders,
  isPendingPrefix,
  folderInputError,
  type PendingPrefixState,
} from '../../../src/storage/pendingPrefixes.js';

const create = (state: PendingPrefixState, path: string) =>
  pendingPrefixReducer(state, { type: 'create', path });
const materialize = (state: PendingPrefixState, path: string) =>
  pendingPrefixReducer(state, { type: 'materialize', path });
const discard = (state: PendingPrefixState, path: string) =>
  pendingPrefixReducer(state, { type: 'discard', path });

describe('expandPathChain', () => {
  it('expands every ancestor level', () => {
    expect(expandPathChain('stuff/things/cool')).toEqual([
      'stuff',
      'stuff/things',
      'stuff/things/cool',
    ]);
  });
  it('normalizes stray slashes', () => {
    expect(expandPathChain('/a//b/')).toEqual(['a', 'a/b']);
  });
  it('root is empty', () => {
    expect(expandPathChain('')).toEqual([]);
  });
});

describe('pendingPrefixReducer', () => {
  it('create adds the whole chain (VS Code nested create)', () => {
    const state = create(initialPendingPrefixes, 'stuff/things/cool');
    expect(state).toEqual(['stuff', 'stuff/things', 'stuff/things/cool']);
  });

  it('create dedups against existing pending entries', () => {
    let state = create(initialPendingPrefixes, 'a/b');
    state = create(state, 'a/c');
    expect(state).toEqual(['a', 'a/b', 'a/c']);
  });

  it('create of an already-pending path returns the same state object', () => {
    const state = create(initialPendingPrefixes, 'a/b');
    expect(create(state, 'a/b')).toBe(state);
  });

  it('materialize retires the destination chain, keeps other branches', () => {
    let state = create(initialPendingPrefixes, 'stuff/things/cool');
    state = create(state, 'stuff/other');
    // An upload landed directly in stuff/things.
    state = materialize(state, 'stuff/things');
    // stuff + stuff/things are real now; deeper + sibling pending stay.
    expect(state).toEqual(['stuff/other', 'stuff/things/cool']);
  });

  it('materialize at root is a no-op', () => {
    const state = create(initialPendingPrefixes, 'a');
    expect(materialize(state, '')).toBe(state);
  });

  it('discard removes an empty pending folder and its descendants', () => {
    let state = create(initialPendingPrefixes, 'stuff/things/cool');
    state = create(state, 'stuff/keep');
    expect(discard(state, 'stuff/things')).toEqual(['stuff', 'stuff/keep']);
  });

  it('clear empties', () => {
    const state = create(initialPendingPrefixes, 'a/b');
    expect(pendingPrefixReducer(state, { type: 'clear' })).toEqual([]);
  });
});

describe('pendingChildFolders', () => {
  it('lists direct children of a parent only', () => {
    let state = create(initialPendingPrefixes, 'stuff/things/cool');
    state = create(state, 'stuff/zebra');
    expect(pendingChildFolders(state, '')).toEqual(['stuff']);
    expect(pendingChildFolders(state, 'stuff')).toEqual(['things', 'zebra']);
    expect(pendingChildFolders(state, 'stuff/things')).toEqual(['cool']);
    expect(pendingChildFolders(state, 'stuff/things/cool')).toEqual([]);
  });
});

describe('isPendingPrefix', () => {
  it('matches normalized paths', () => {
    const state = create(initialPendingPrefixes, 'a/b');
    expect(isPendingPrefix(state, 'a/b/')).toBe(true);
    expect(isPendingPrefix(state, 'a/c')).toBe(false);
  });
});

describe('folderInputError', () => {
  it('accepts plain and nested names', () => {
    expect(folderInputError('docs')).toBeNull();
    expect(folderInputError('stuff/things/cool')).toBeNull();
    // Stray slashes normalize rather than error (VS Code tolerance).
    expect(folderInputError('/a//b/')).toBeNull();
  });
  it('rejects empty input', () => {
    expect(folderInputError('')).not.toBeNull();
    expect(folderInputError('///')).not.toBeNull();
  });
  it('rejects dot segments', () => {
    expect(folderInputError('..')).not.toBeNull();
    expect(folderInputError('a/./b')).not.toBeNull();
    expect(folderInputError('a/../b')).not.toBeNull();
  });
});

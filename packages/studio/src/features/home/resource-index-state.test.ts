import { describe, expect, it } from 'bun:test';
import { createIndexBatchPublisher, foldIndexBatch, type ResourceIndexUpdate } from './resource-index-state.js';
import { documentEntry, objectEntry, userEntry } from './typeahead.js';

describe('createIndexBatchPublisher', () => {
  it('replaces the previous build when React applies progressive updates later', () => {
    const updates: ResourceIndexUpdate[] = [];
    const publish = createIndexBatchPublisher((update) => updates.push(update));

    publish([documentEntry('users/alice')]);
    publish([userEntry({ uid: 'alice', email: 'alice@gmail.com' })]);
    publish([objectEntry('avatars/alice.png')]);

    let entries = [
      documentEntry('users/bob'),
      userEntry({ uid: 'bob', email: 'bob@gmail.com' }),
      objectEntry('avatars/bob.png'),
    ];
    for (const update of updates) entries = update(entries);

    expect(entries.map((entry) => `${entry.kind}:${entry.label}`)).toEqual([
      'document:users/alice',
      'user:alice@gmail.com',
      'object:avatars/alice.png',
    ]);
  });
});

describe('foldIndexBatch', () => {
  it('keeps one entry per stable resource target', () => {
    const alice = documentEntry('users/alice');

    expect(foldIndexBatch(null, [alice, alice], true)).toEqual([alice]);
  });

  it('lets the latest representation of a resource replace the old one', () => {
    const previous = userEntry({ uid: 'alice', email: 'old-alice@gmail.com' });
    const current = userEntry({ uid: 'alice', email: 'alice@gmail.com' });

    expect(foldIndexBatch([previous], [current], false)).toEqual([current]);
  });
});

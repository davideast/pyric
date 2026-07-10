import { describe, expect, it } from 'bun:test';
import { asVectorView, initState, vectorPreview } from '@pyric/ui/firestore';
import {
  containerPreview,
  fieldPath,
  firestoreRowIdentity,
  rowLabel,
  shouldSkipDeleteConfirm,
  siblingKeyTaken,
  firestoreDataUpdateEntries,
} from './firestoreTreeLogic.js';

// The real `@pyric/ui` vector helpers — `containerPreview` takes them as
// parameters (rather than importing them itself) purely to stay a pure
// function of its inputs, not because these tests need fakes.
const vectorHelpers = { asVectorView, vectorPreview };

describe('rowLabel', () => {
  it('array index chips render the positional index, not the map key convention', () => {
    const { tree } = initState({ tags: ['5k', '10k', '20k'] });
    const tagsId = tree.childIds[tree.rootId][0];
    const childIds = tree.childIds[tagsId];
    expect(childIds.map((id) => rowLabel(tree, id))).toEqual([
      { label: '0', isArrayChild: true },
      { label: '1', isArrayChild: true },
      { label: '2', isArrayChild: true },
    ]);
  });

  it('map children label by their key', () => {
    const { tree } = initState({ city: 'Potomac' });
    const cityId = tree.childIds[tree.rootId][0];
    expect(rowLabel(tree, cityId)).toEqual({ label: 'city', isArrayChild: false });
  });
});

describe('containerPreview', () => {
  it('truncates a large array to a leading-elements preview with an ellipsis', () => {
    const { tree } = initState({ tags: ['5k', '10k', '20k', '40k', '80k'] });
    const tagsId = tree.childIds[tree.rootId][0];
    const preview = containerPreview(tree, tagsId, vectorHelpers);
    expect(preview).toContain('…');
    expect(preview.startsWith('["5k", "10k", "20k"')).toBe(true);
  });

  it('does not truncate a short array (no ellipsis needed)', () => {
    const { tree } = initState({ tags: ['a', 'b'] });
    const tagsId = tree.childIds[tree.rootId][0];
    expect(containerPreview(tree, tagsId, vectorHelpers)).toBe('["a", "b"]');
  });

  it('previews a map showing its first couple keys, matching the console format', () => {
    const { tree } = initState({
      searchEmbedding: {
        _values: { __type__: '__vector__', value: [-0.01973384, 0.5] },
        dims: 2,
      },
    });
    const embeddingId = tree.childIds[tree.rootId][0];
    const preview = containerPreview(tree, embeddingId, vectorHelpers);
    expect(preview.startsWith('{"_values": vector · 2')).toBe(true);
    expect(preview).toContain('…');
  });

  it('hard-caps the preview length even for a pathologically long single value', () => {
    const { tree } = initState({ note: 'x'.repeat(500) });
    const noteId = tree.childIds[tree.rootId][0];
    // `note` is a leaf, not a container, but the cap itself is a plain
    // string-length check — exercise it via a map wrapping the long value.
    const { tree: wrapped } = initState({ obj: { note: 'x'.repeat(500) } });
    const objId = wrapped.childIds[wrapped.rootId][0];
    const preview = containerPreview(wrapped, objId, vectorHelpers, 42);
    expect(preview.length).toBeLessThanOrEqual(42);
    expect(preview.endsWith('…')).toBe(true);
    void noteId; // unused id kept only to document intent above
  });
});

describe('siblingKeyTaken', () => {
  it('flags a draft key that collides with a sibling', () => {
    const { tree } = initState({ a: 1, b: 2 });
    const bId = tree.childIds[tree.rootId].find((id) => tree.nodes[id].key === 'b')!;
    const bNode = tree.nodes[bId];
    expect(siblingKeyTaken(tree, bNode, 'a')).toBe(true);
    expect(siblingKeyTaken(tree, bNode, 'b')).toBe(false); // its own key is fine
    expect(siblingKeyTaken(tree, bNode, 'c')).toBe(false);
  });

  it('the document root has no siblings to collide with', () => {
    const { tree } = initState({});
    expect(siblingKeyTaken(tree, tree.nodes[tree.rootId], 'anything')).toBe(false);
  });
});

describe('shouldSkipDeleteConfirm', () => {
  it('a shift-click skips the confirmation dialog', () => {
    expect(shouldSkipDeleteConfirm({ shiftKey: true })).toBe(true);
  });

  it('a plain click requires confirmation', () => {
    expect(shouldSkipDeleteConfirm({ shiftKey: false })).toBe(false);
  });
});

describe('fieldPath', () => {
  it('builds a dotted path for nested map fields', () => {
    const { tree } = initState({ addr: { city: 'SF' } });
    const addrId = tree.childIds[tree.rootId][0];
    const cityId = tree.childIds[addrId][0];
    expect(fieldPath(tree, cityId)).toBe('addr.city');
  });

  it('builds a bracketed path for array elements', () => {
    const { tree } = initState({ tags: ['a', 'b'] });
    const tagsId = tree.childIds[tree.rootId][0];
    const secondId = tree.childIds[tagsId][1];
    expect(fieldPath(tree, secondId)).toBe('tags[1]');
  });
});

describe('firestoreDataUpdateEntries', () => {
  it('fingerprints leaf values and only the direct shape of containers', () => {
    const data = { profile: { name: 'Ada', tags: ['one', 'two'] } };
    const entries = firestoreDataUpdateEntries(
      data,
      (value) =>
        Array.isArray(value)
          ? 'array'
          : value !== null && typeof value === 'object'
            ? 'map'
            : typeof value === 'string'
              ? 'string'
              : 'number',
    );
    const { tree } = initState(data);
    const profileId = tree.childIds[tree.rootId][0];
    const nameId = tree.childIds[profileId][0];
    const tagsId = tree.childIds[profileId][1];
    const secondTagId = tree.childIds[tagsId][1];

    expect(entries.get(firestoreRowIdentity(tree, profileId))).toEqual([
      'map',
      ['name', 'tags'],
    ]);
    expect(entries.get(firestoreRowIdentity(tree, nameId))).toEqual(['string', 'Ada']);
    expect(entries.get(firestoreRowIdentity(tree, tagsId))).toEqual([
      'array',
      ['0', '1'],
    ]);
    expect(entries.get(firestoreRowIdentity(tree, secondTagId))).toEqual([
      'string',
      'two',
    ]);
  });

  it('keeps literal dotted and bracketed field names distinct from nesting', () => {
    const data = {
      'a.b': 'literal dot',
      a: { b: 'nested dot' },
      'tags[0]': 'literal bracket',
      tags: ['nested bracket'],
    };
    const entries = firestoreDataUpdateEntries(data, (value) =>
      Array.isArray(value)
        ? 'array'
        : value !== null && typeof value === 'object'
          ? 'map'
          : 'string',
    );
    const { tree } = initState(data);
    const identities = Object.values(tree.nodes)
      .filter((node) => node.parentId !== null && node.type === 'string')
      .map((node) => firestoreRowIdentity(tree, node.id));

    expect(new Set(identities).size).toBe(4);
    expect(
      identities.map(
        (identity) => (entries.get(identity) as readonly unknown[] | undefined)?.[1],
      ),
    ).toEqual(['literal dot', 'nested dot', 'literal bracket', 'nested bracket']);
  });
});

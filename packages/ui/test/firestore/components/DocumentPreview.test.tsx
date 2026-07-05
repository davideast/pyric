// Install JSDOM globals before importing React or RTL — see bunfig.toml
// for why this isn't preloaded globally.
import { JSDOM } from 'jsdom';
const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>', { pretendToBeVisual: true });
const g = globalThis as any;
g.window = dom.window;
g.document = dom.window.document;
g.HTMLElement = dom.window.HTMLElement;
g.Element = dom.window.Element;
g.Node = dom.window.Node;
g.getComputedStyle = dom.window.getComputedStyle.bind(dom.window);
g.IS_REACT_ACT_ENVIRONMENT = true;

import { afterEach, describe, it, expect } from 'bun:test';
import { render, cleanup, fireEvent, act, waitFor } from '@testing-library/react';
import { Timestamp, GeoPoint, Bytes } from 'pyric/firestore';
import type {
  CollectionReference,
  DocumentReference,
  DocumentSnapshot,
  Firestore,
} from 'pyric/firestore';
import {
  DocumentPreview,
  type FieldEditorContract,
} from '../../../src/firestore/index.js';

afterEach(() => {
  cleanup();
});

// Build a minimal DocumentSnapshot stub. The library's
// `DocumentPreview` only touches `exists`, `data()`, and `id` — the
// rest of the Snapshot surface is irrelevant to display.
function snap(id: string, data: Record<string, unknown> | null) {
  return {
    id,
    exists: () => data !== null,
    data: () => data ?? undefined,
    // Fields the type expects but the component doesn't read. Cast
    // to suppress missing-prop noise.
  } as unknown as DocumentSnapshot;
}

function query(container: HTMLElement, sel: string) {
  const el = container.querySelector(sel);
  if (!el) throw new Error(`No element matching ${sel}`);
  return el as HTMLElement;
}

describe('DocumentPreview', () => {
  it('renders nothing for a null snapshot', () => {
    const { container } = render(<DocumentPreview snapshot={null} />);
    expect(container.firstChild).toBeNull();
  });

  it('renders the empty-state fallback when snapshot does not exist', () => {
    const { container } = render(
      <DocumentPreview snapshot={snap('ghost', null)} emptyState={<p>missing</p>} />,
    );
    expect(container.textContent).toBe('missing');
  });

  it('renders top-level fields in lexicographic order', () => {
    const { container } = render(
      <DocumentPreview
        snapshot={snap('alice', { zeta: 1, alpha: 2, mu: 3 })}
      />,
    );
    const keys = Array.from(
      container.querySelectorAll('[data-pyric-field-entry]'),
    ).map((el) => (el as HTMLElement).dataset.fieldName);
    expect(keys).toEqual(['alpha', 'mu', 'zeta']);
  });

  it('exposes doc id on the root', () => {
    const { container } = render(
      <DocumentPreview snapshot={snap('alice', { name: 'A' })} />,
    );
    const root = query(container, '[data-pyric-ui="document-preview"]');
    expect(root.dataset.docId).toBe('alice');
  });

  it('renders a string field with data-pyric-field-type="string"', () => {
    const { container } = render(
      <DocumentPreview snapshot={snap('a', { name: 'Alice' })} />,
    );
    const el = query(container, '[data-pyric-field-type="string"]');
    expect(el.textContent).toBe('Alice');
    expect(el.dataset.pyricFieldPath).toBe('name');
  });

  it('renders a number field', () => {
    const { container } = render(
      <DocumentPreview snapshot={snap('a', { score: 42 })} />,
    );
    const el = query(container, '[data-pyric-field-type="number"]');
    expect(el.textContent).toBe('42');
  });

  it('renders a boolean field with data-value', () => {
    const { container } = render(
      <DocumentPreview snapshot={snap('a', { active: true })} />,
    );
    const el = query(container, '[data-pyric-field-type="boolean"]');
    expect(el.textContent).toBe('true');
    expect(el.dataset.value).toBe('true');
  });

  it('renders a null field', () => {
    const { container } = render(
      <DocumentPreview snapshot={snap('a', { missing: null })} />,
    );
    const el = query(container, '[data-pyric-field-type="null"]');
    expect(el.textContent).toBe('null');
  });

  it('renders a timestamp field as ISO via <time>', () => {
    const date = new Date('2025-04-01T12:34:56Z');
    const { container } = render(
      <DocumentPreview
        snapshot={snap('a', { createdAt: Timestamp.fromDate(date) })}
      />,
    );
    const el = query(container, 'time[data-pyric-field-type="timestamp"]');
    expect(el.getAttribute('dateTime')).toBe('2025-04-01T12:34:56.000Z');
    expect(el.textContent).toBe('2025-04-01T12:34:56.000Z');
  });

  it('renders a geopoint field with lat/lng dataset', () => {
    const { container } = render(
      <DocumentPreview
        snapshot={snap('a', { loc: new GeoPoint(37.7749, -122.4194) })}
      />,
    );
    const el = query(container, '[data-pyric-field-type="geopoint"]');
    expect(el.dataset.lat).toBe('37.7749');
    expect(el.dataset.lng).toBe('-122.4194');
  });

  it('renders a bytes field as base64 inside <code>', () => {
    const { container } = render(
      <DocumentPreview
        snapshot={snap('a', { blob: Bytes.fromBase64String('aGVsbG8=') })}
      />,
    );
    const el = query(container, 'code[data-pyric-field-type="bytes"]');
    expect(el.textContent).toBe('aGVsbG8=');
  });

  it('renders a reference field with target path', () => {
    const refLike = {
      path: 'users/bob',
      id: 'bob',
      firestore: { _isFirestore: true },
      type: 'document',
    };
    const { container } = render(
      <DocumentPreview snapshot={snap('a', { owner: refLike })} />,
    );
    const el = query(container, '[data-pyric-field-type="reference"]');
    expect(el.textContent).toBe('users/bob');
    expect(el.dataset.targetPath).toBe('users/bob');
    // No onReferenceClick → not clickable → stays a <span>.
    expect(el.tagName.toLowerCase()).toBe('span');
  });

  it('renders references as clickable buttons when onReferenceClick is provided', () => {
    const refLike = {
      path: 'users/bob',
      id: 'bob',
      firestore: { _isFirestore: true },
      type: 'document',
    };
    let clicked: { path: string } | null = null;
    const { container } = render(
      <DocumentPreview
        snapshot={snap('a', { owner: refLike })}
        onReferenceClick={(ref) => {
          clicked = ref;
        }}
      />,
    );
    const btn = query(container, 'button[data-pyric-field-type="reference"]');
    expect(btn.dataset.targetPath).toBe('users/bob');
    expect(btn.hasAttribute('data-pyric-clickable')).toBe(true);
    act(() => {
      fireEvent.click(btn);
    });
    expect(clicked?.path).toBe('users/bob');
  });

  it('renders a map field recursively', () => {
    const { container } = render(
      <DocumentPreview
        snapshot={snap('a', { addr: { city: 'SF', zip: '94110' } })}
      />,
    );
    const map = query(container, '[data-pyric-field-type="map"]');
    expect(map.querySelectorAll('[data-pyric-tree-entry]').length).toBe(2);
    const city = query(map, '[data-field-name="city"] [data-pyric-field-type="string"]');
    expect(city.textContent).toBe('SF');
    expect(city.dataset.pyricFieldPath).toBe('addr.city');
  });

  it('renders an array field recursively', () => {
    const { container } = render(
      <DocumentPreview snapshot={snap('a', { tags: ['admin', 'beta'] })} />,
    );
    const arr = query(container, '[data-pyric-field-type="array"]');
    const items = arr.querySelectorAll('[data-pyric-tree-entry]');
    expect(items.length).toBe(2);
    const first = query(arr, '[data-field-index="0"] [data-pyric-field-type="string"]');
    expect(first.textContent).toBe('admin');
    expect(first.dataset.pyricFieldPath).toBe('tags[0]');
  });

  it('handles deeply nested map+array recursion', () => {
    const { container } = render(
      <DocumentPreview
        snapshot={snap('a', {
          users: [
            { name: 'Alice', tags: ['admin'] },
            { name: 'Bob', tags: [] },
          ],
        })}
      />,
    );
    const alice = query(
      container,
      '[data-pyric-field-path="users[0].tags[0]"]',
    );
    expect(alice.textContent).toBe('admin');
  });

  it('forwards className to the root', () => {
    const { container } = render(
      <DocumentPreview snapshot={snap('a', { x: 1 })} className="my-doc" />,
    );
    const root = query(container, '[data-pyric-ui="document-preview"]');
    expect(root.className).toBe('my-doc');
  });

  it('lets consumers override a specific field editor', () => {
    const override: FieldEditorContract<string> = {
      type: 'string',
      Display: ({ value }) => <em data-custom>{value.toUpperCase()}</em>,
    };
    const { container } = render(
      <DocumentPreview
        snapshot={snap('a', { name: 'alice' })}
        fieldEditors={{ string: override }}
      />,
    );
    const el = query(container, '[data-custom]');
    expect(el.textContent).toBe('ALICE');
    // Make sure default editors for OTHER types are still active.
    const { container: c2 } = render(
      <DocumentPreview
        snapshot={snap('a', { score: 99 })}
        fieldEditors={{ string: override }}
      />,
    );
    const num = query(c2, '[data-pyric-field-type="number"]');
    expect(num.textContent).toBe('99');
  });

  describe('vector field', () => {
    const embedding = (n: number) =>
      Array.from({ length: n }, (_, i) => Number((i / 1000).toFixed(3)));

    it('renders a vector field as "vector · <dims>" with a truncated preview', () => {
      const { container } = render(
        <DocumentPreview
          snapshot={snap('a', {
            embedding: { __type__: '__vector__', value: embedding(768) },
          })}
        />,
      );
      const el = query(container, '[data-pyric-field-type="vector"]');
      expect(el.dataset.dimension).toBe('768');
      const dimsLabel = query(el, '[data-pyric-vector-dims]');
      expect(dimsLabel.textContent).toBe('vector · 768');
      // Preview is truncated — shows a few leading components + ellipsis,
      // never all 768 floats.
      const preview = query(el, '[data-pyric-vector-preview]');
      expect(preview.textContent).toContain('…');
      expect(preview.textContent!.length).toBeLessThan(60);
    });

    it('renders a short vector in full without an ellipsis', () => {
      const { container } = render(
        <DocumentPreview
          snapshot={snap('a', {
            embedding: { __type__: '__vector__', value: [0.1, 0.2] },
          })}
        />,
      );
      const preview = query(container, '[data-pyric-vector-preview]');
      expect(preview.textContent).toBe('[0.1, 0.2]');
    });

    it('does not classify a plain numeric array as a vector', () => {
      const { container } = render(
        <DocumentPreview snapshot={snap('a', { scores: [1, 2, 3] })} />,
      );
      expect(container.querySelector('[data-pyric-field-type="vector"]')).toBeNull();
      expect(
        container.querySelector('[data-pyric-field-type="array"]'),
      ).not.toBeNull();
    });
  });

  describe('subcollections', () => {
    function collRef(id: string, path: string): CollectionReference {
      return { id, path } as unknown as CollectionReference;
    }
    const firestore = {} as Firestore;
    const docRef = { id: 'p1', path: 'posts/p1' } as unknown as DocumentReference;

    it('lists a document\'s own subcollections', async () => {
      const lister = async () => [
        collRef('comments', 'posts/p1/comments'),
        collRef('revisions', 'posts/p1/revisions'),
      ];
      const { container } = render(
        <DocumentPreview
          snapshot={snap('p1', { title: 'Hi' })}
          firestore={firestore}
          documentRef={docRef}
          listSubcollections={lister}
        />,
      );
      await waitFor(() => {
        expect(
          container.querySelectorAll('[data-pyric-subcollection]').length,
        ).toBe(2);
      });
      const items = Array.from(
        container.querySelectorAll('[data-pyric-subcollection]'),
      ) as HTMLElement[];
      expect(items.map((el) => el.dataset.pyricCollectionId)).toEqual([
        'comments',
        'revisions',
      ]);
      expect(items[0].dataset.pyricCollectionPath).toBe('posts/p1/comments');
      const heading = query(container, '[data-pyric-subcollections-group]');
      expect(heading.textContent).toBe('Subcollections');
    });

    it('emits the subcollection ref through onSubcollectionClick', async () => {
      const lister = async () => [collRef('comments', 'posts/p1/comments')];
      let navigated: CollectionReference | null = null;
      const { container } = render(
        <DocumentPreview
          snapshot={snap('p1', { title: 'Hi' })}
          firestore={firestore}
          documentRef={docRef}
          listSubcollections={lister}
          onSubcollectionClick={(c) => {
            navigated = c;
          }}
        />,
      );
      const drill = await waitFor(() =>
        query(container, '[data-pyric-subcollection-drill]'),
      );
      act(() => {
        fireEvent.click(drill);
      });
      expect(navigated).not.toBeNull();
      expect((navigated as unknown as CollectionReference).path).toBe(
        'posts/p1/comments',
      );
    });

    it('renders no Subcollections section when the document has none', async () => {
      const lister = async () => [];
      const { container } = render(
        <DocumentPreview
          snapshot={snap('p1', { title: 'Hi' })}
          firestore={firestore}
          documentRef={docRef}
          listSubcollections={lister}
        />,
      );
      // Give the lister a microtask to resolve, then assert absence.
      await act(async () => {
        await Promise.resolve();
      });
      await waitFor(() => {
        expect(
          container.querySelector('[data-pyric-ui="subcollections"]'),
        ).toBeNull();
      });
    });

    it('omits the section entirely when no lister is provided', () => {
      const { container } = render(
        <DocumentPreview snapshot={snap('p1', { title: 'Hi' })} />,
      );
      expect(
        container.querySelector('[data-pyric-ui="subcollections"]'),
      ).toBeNull();
    });
  });
});

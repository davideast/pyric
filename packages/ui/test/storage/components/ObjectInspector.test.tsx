// Install JSDOM globals before importing React or RTL.
import { JSDOM } from 'jsdom';
const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>', { pretendToBeVisual: true });
const g = globalThis as any;
g.window = dom.window;
g.document = dom.window.document;
g.HTMLElement = dom.window.HTMLElement;
g.Element = dom.window.Element;
g.Node = dom.window.Node;
g.ResizeObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
};
g.getComputedStyle = dom.window.getComputedStyle.bind(dom.window);
g.IS_REACT_ACT_ENVIRONMENT = true;

// Real sandbox behind the component (no rules — the firestore-rules
// OHM parser fights JSDOM globals; rules-path behavior is covered by
// the DOM-less hook probes). Assign the fakes explicitly onto
// globalThis: `fake-indexeddb/auto` targets `window` when one exists,
// and in a shared bun:test process another component file's JSDOM
// setup may have installed `window` first — bare `indexedDB` lookups
// resolve on globalThis, not the jsdom window.
import { indexedDB as fakeIndexedDB, IDBKeyRange as fakeIDBKeyRange } from 'fake-indexeddb';
g.indexedDB = fakeIndexedDB;
g.IDBKeyRange = fakeIDBKeyRange;
import { afterEach, describe, it, expect } from 'bun:test';
import { render, cleanup, waitFor } from '@testing-library/react';
import { initializeSandbox } from 'pyric/sandbox';
import {
  getStorageSandbox,
  ref,
  uploadBytes,
  type FirebaseStorage,
} from 'pyric/storage';
import { ObjectInspector, type StoragePreview } from '../../../src/storage/index.js';

afterEach(() => cleanup());

function makeStorage(label: string): FirebaseStorage {
  const sandbox = initializeSandbox({});
  return getStorageSandbox(sandbox, {
    dbName: `pyric-ui-inspector-${label}-${Math.random().toString(36).slice(2, 10)}`,
  });
}

describe('ObjectInspector', () => {
  it('renders the idle shell for a null path', () => {
    const { container } = render(
      <ObjectInspector storage={makeStorage('idle')} path={null} />,
    );
    const root = container.querySelector('[data-pyric-ui="object-inspector"]')!;
    expect(root.hasAttribute('data-pyric-idle')).toBe(true);
  });

  it('renders metadata fields and the metadata-only fallback for unknown types', async () => {
    const storage = makeStorage('meta');
    await uploadBytes(ref(storage, 'docs/blob.bin'), new Uint8Array(4), {
      customMetadata: { owner: 'alice' },
    });

    const { container } = render(<ObjectInspector storage={storage} path="docs/blob.bin" />);
    await waitFor(() =>
      expect(container.querySelector('[data-pyric-object-name]')).not.toBeNull(),
    );

    expect(container.querySelector('[data-pyric-object-name]')!.textContent).toBe('blob.bin');
    const field = (key: string) =>
      container.querySelector(`[data-pyric-metadata-field="${key}"] dd`)!.textContent;
    expect(field('fullPath')).toBe('docs/blob.bin');
    expect(field('size')).toBe('4');
    expect(field('contentType')).toBe('application/octet-stream');
    // Custom metadata rows carry the key.
    const custom = container.querySelector('[data-pyric-metadata-key="owner"]')!;
    expect(custom.querySelector('dd')!.textContent).toBe('alice');
    // No registry match → metadata-only preview state.
    const preview = container.querySelector('[data-pyric-object-preview]')!;
    expect(preview.hasAttribute('data-pyric-preview-none')).toBe(true);
  });

  it('image/*: auto-loads the blob and renders a blob-URL <img>', async () => {
    const storage = makeStorage('image');
    await uploadBytes(ref(storage, 'cat.png'), new Uint8Array([137, 80, 78, 71]), {
      contentType: 'image/png',
    });

    const { container } = render(<ObjectInspector storage={storage} path="cat.png" />);
    await waitFor(() =>
      expect(container.querySelector('[data-pyric-preview-image]')).not.toBeNull(),
    );
    const img = container.querySelector('[data-pyric-preview-image]') as HTMLImageElement;
    expect(img.getAttribute('src')).toStartWith('blob:');
    expect(img.getAttribute('alt')).toBe('cat.png');
    expect(
      container.querySelector('[data-pyric-object-preview]')!.getAttribute('data-pyric-preview'),
    ).toBe('image');
  });

  it('text/*: renders the text panel', async () => {
    const storage = makeStorage('text');
    await uploadBytes(ref(storage, 'note.txt'), new Blob(['hello world']), {
      contentType: 'text/plain',
    });

    const { container } = render(<ObjectInspector storage={storage} path="note.txt" />);
    await waitFor(() =>
      expect(container.querySelector('[data-pyric-preview-text]')).not.toBeNull(),
    );
    expect(container.querySelector('[data-pyric-preview-text]')!.textContent).toBe(
      'hello world',
    );
  });

  it('application/json: pretty-prints parseable JSON', async () => {
    const storage = makeStorage('json');
    await uploadBytes(ref(storage, 'data.json'), new Blob(['{"a":{"b":1}}']), {
      contentType: 'application/json',
    });

    const { container } = render(<ObjectInspector storage={storage} path="data.json" />);
    await waitFor(() =>
      expect(container.querySelector('[data-pyric-preview-text]')).not.toBeNull(),
    );
    expect(container.querySelector('[data-pyric-preview-text]')!.textContent).toBe(
      JSON.stringify({ a: { b: 1 } }, null, 2),
    );
  });

  it('PIN: text objects over the 256KB cap skip the preview (and the download)', async () => {
    const storage = makeStorage('cap');
    const big = new Blob([new Uint8Array(256 * 1024 + 1)]);
    await uploadBytes(ref(storage, 'big.txt'), big, { contentType: 'text/plain' });

    const { container } = render(<ObjectInspector storage={storage} path="big.txt" />);
    await waitFor(() =>
      expect(container.querySelector('[data-pyric-object-preview]')).not.toBeNull(),
    );
    const preview = container.querySelector('[data-pyric-object-preview]')!;
    expect(preview.hasAttribute('data-pyric-preview-too-large')).toBe(true);
    expect(container.querySelector('[data-pyric-preview-text]')).toBeNull();
  });

  it('consumer previews run before the built-ins', async () => {
    const storage = makeStorage('override');
    await uploadBytes(ref(storage, 'note.txt'), new Blob(['x']), {
      contentType: 'text/plain',
    });
    const custom: StoragePreview = {
      id: 'custom-text',
      match: (md) => (md.contentType ?? '').startsWith('text/'),
      render: ({ metadata }) => <em data-custom-preview>{metadata.name}</em>,
    };

    const { container } = render(
      <ObjectInspector storage={storage} path="note.txt" previews={[custom]} />,
    );
    await waitFor(() =>
      expect(container.querySelector('[data-custom-preview]')).not.toBeNull(),
    );
    expect(
      container.querySelector('[data-pyric-object-preview]')!.getAttribute('data-pyric-preview'),
    ).toBe('custom-text');
    // The built-in text panel did not render (and no blob was needed).
    expect(container.querySelector('[data-pyric-preview-text]')).toBeNull();
  });

  it('renders the error state for a missing object', async () => {
    const storage = makeStorage('missing');
    const { container } = render(<ObjectInspector storage={storage} path="nope.txt" />);
    await waitFor(() =>
      expect(
        container
          .querySelector('[data-pyric-ui="object-inspector"]')!
          .hasAttribute('data-pyric-error'),
      ).toBe(true),
    );
    const root = container.querySelector('[data-pyric-ui="object-inspector"]')!;
    expect(root.getAttribute('role')).toBe('alert');
    expect(root.textContent).toContain('storage/object-not-found');
  });

  it('renders the children slot below the preview', async () => {
    const storage = makeStorage('slot');
    await uploadBytes(ref(storage, 'a.bin'), new Uint8Array(1));
    const { container } = render(
      <ObjectInspector storage={storage} path="a.bin">
        <button data-extra-action>Delete</button>
      </ObjectInspector>,
    );
    await waitFor(() =>
      expect(container.querySelector('[data-extra-action]')).not.toBeNull(),
    );
  });
});

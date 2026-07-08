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

// Real sandbox behind the rules-gate probes. Storage rules use the
// hand-rolled `pyric/storage` parser (NOT the firestore OHM one that
// fights JSDOM globals), so deploying rules in a DOM test is safe.
// Assign the IDB fakes explicitly onto globalThis — see
// ObjectInspector.test.tsx for why `fake-indexeddb/auto` isn't enough
// in a shared bun:test process.
import { indexedDB as fakeIndexedDB, IDBKeyRange as fakeIDBKeyRange } from 'fake-indexeddb';
g.indexedDB = fakeIndexedDB;
g.IDBKeyRange = fakeIDBKeyRange;

import { afterEach, describe, it, expect } from 'bun:test';
import { render, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { initializeSandbox } from 'pyric/sandbox';
import { getStorageSandbox, type FirebaseStorage, type StorageReference } from 'pyric/storage';
import { ObjectBrowser, useStorageRulesGate } from '../../../src/storage/index.js';
import type { StorageListEntry } from '../../../src/storage/index.js';

afterEach(() => cleanup());

// Structural fake — same approach as DocumentList.test.tsx's fakeSnap.
// The component only reads `name`/`fullPath`/`ref`; hook tests cover
// real refs end-to-end.
function fakeEntry(kind: 'folder' | 'object', fullPath: string): StorageListEntry {
  const name = fullPath.split('/').pop() ?? '';
  const ref = { fullPath, name, bucket: 'b' } as unknown as StorageReference;
  return { kind, name, fullPath, ref };
}

function queryAll(c: HTMLElement, sel: string): HTMLElement[] {
  return Array.from(c.querySelectorAll(sel)) as HTMLElement[];
}

const ENTRIES: StorageListEntry[] = [
  fakeEntry('folder', 'docs/sub'),
  fakeEntry('folder', 'docs/zarchive'),
  fakeEntry('object', 'docs/a.txt'),
  fakeEntry('object', 'docs/readme.md'),
];

describe('ObjectBrowser', () => {
  it('renders folder + object rows with kind/path data attributes', () => {
    const { container } = render(<ObjectBrowser entries={ENTRIES} />);
    const rows = queryAll(container, '[data-pyric-storage-entry]');
    expect(rows.length).toBe(4);
    expect(rows.map((r) => r.getAttribute('data-pyric-entry-kind'))).toEqual([
      'folder',
      'folder',
      'object',
      'object',
    ]);
    expect(rows[0].getAttribute('data-pyric-entry-path')).toBe('docs/sub');
    // Default label = entry name.
    expect(rows[2].textContent).toBe('a.txt');
    // The root stamps data-size (container-query convention).
    const root = container.querySelector('[data-pyric-ui="object-browser"]')!;
    expect(root.getAttribute('data-size')).toBe('wide');
  });

  it('folder rows navigate, object rows select', () => {
    const navigated: string[] = [];
    const selected: string[] = [];
    const { container } = render(
      <ObjectBrowser
        entries={ENTRIES}
        onNavigate={(p) => navigated.push(p)}
        onSelect={(ref) => selected.push(ref.fullPath)}
      />,
    );
    const buttons = queryAll(container, '[data-pyric-entry-select]');
    fireEvent.click(buttons[0]); // folder docs/sub
    fireEvent.click(buttons[2]); // object docs/a.txt
    expect(navigated).toEqual(['docs/sub']);
    expect(selected).toEqual(['docs/a.txt']);
  });

  it('marks the selected object row', () => {
    const { container } = render(
      <ObjectBrowser entries={ENTRIES} selectedPath="docs/a.txt" />,
    );
    const marked = queryAll(container, '[data-pyric-selected]');
    expect(marked.length).toBe(1);
    expect(marked[0].textContent).toBe('a.txt');
    expect(marked[0].getAttribute('aria-selected')).toBe('true');
    // A folder with the same path would never mark — selection is
    // object-only.
    const { container: c2 } = render(
      <ObjectBrowser entries={ENTRIES} selectedPath="docs/sub" />,
    );
    expect(queryAll(c2, '[data-pyric-selected]').length).toBe(0);
  });

  it('renderEntry slot overrides the row label, wiring stays', () => {
    const navigated: string[] = [];
    const { container } = render(
      <ObjectBrowser
        entries={ENTRIES}
        onNavigate={(p) => navigated.push(p)}
        renderEntry={(e) => <em>{e.kind === 'folder' ? `${e.name}/` : e.name}</em>}
      />,
    );
    const rows = queryAll(container, '[data-pyric-storage-entry]');
    expect(rows[0].querySelector('em')!.textContent).toBe('sub/');
    fireEvent.click(rows[0].querySelector('[data-pyric-entry-select]')!);
    expect(navigated).toEqual(['docs/sub']);
  });

  it('renders loading, idle, empty, and error states', () => {
    const { container: loading } = render(
      <ObjectBrowser entries={[]} status="loading" />,
    );
    expect(
      loading.querySelector('[data-pyric-ui="object-browser"]')!
        .hasAttribute('data-pyric-loading'),
    ).toBe(true);

    const { container: idle } = render(<ObjectBrowser entries={[]} status="idle" />);
    expect(
      idle.querySelector('[data-pyric-ui="object-browser"]')!
        .hasAttribute('data-pyric-idle'),
    ).toBe(true);

    const { container: empty } = render(
      <ObjectBrowser entries={[]} status="success" emptyState={<p>Nothing</p>} />,
    );
    const emptyRoot = empty.querySelector('[data-pyric-ui="object-browser"]')!;
    expect(emptyRoot.hasAttribute('data-pyric-empty')).toBe(true);
    expect(emptyRoot.textContent).toBe('Nothing');

    const { container: errored } = render(
      <ObjectBrowser
        entries={[]}
        status="error"
        error={new Error('storage/unauthorized: list denied')}
      />,
    );
    const errorRoot = errored.querySelector('[data-pyric-ui="object-browser"]')!;
    expect(errorRoot.hasAttribute('data-pyric-error')).toBe(true);
    expect(errorRoot.getAttribute('role')).toBe('alert');
    expect(errorRoot.textContent).toContain('storage/unauthorized');
  });

  it('switches to virtualized rendering above the threshold', () => {
    const many = Array.from({ length: 25 }, (_, i) =>
      fakeEntry('object', `docs/file-${String(i).padStart(2, '0')}.txt`),
    );
    const { container } = render(
      <ObjectBrowser entries={many} virtualizeThreshold={10} />,
    );
    const root = container.querySelector('[data-pyric-ui="object-browser"]') as HTMLElement;
    expect(root.hasAttribute('data-pyric-virtualized')).toBe(true);
    expect(container.querySelector('[data-pyric-object-browser-items]')).toBeNull();
    expect(container.querySelector('[data-pyric-ui="virtual-list"]')).not.toBeNull();
  });

  it('keeps the plain renderer below the threshold', () => {
    const { container } = render(
      <ObjectBrowser entries={ENTRIES} virtualizeThreshold={10} />,
    );
    const root = container.querySelector('[data-pyric-ui="object-browser"]') as HTMLElement;
    expect(root.hasAttribute('data-pyric-virtualized')).toBe(false);
    expect(container.querySelector('[data-pyric-object-browser-items]')).not.toBeNull();
    expect(container.querySelector('[data-pyric-ui="virtual-list"]')).toBeNull();
  });

  describe('rules gate affordances (M7)', () => {
    // Owner-only tree, deployed onto a REAL sandbox the way every
    // pyric storage rules test deploys it: first factory call wins.
    const OWNER_RULES = `
service firebase.storage {
  match /users/{uid}/{allPaths=**} {
    allow read, write: if request.auth != null && request.auth.uid == uid;
  }
  match /public/{allPaths=**} {
    allow read: if true;
  }
}`;

    const GATE_ENTRIES: StorageListEntry[] = [
      fakeEntry('folder', 'users/alice'),
      fakeEntry('folder', 'users/bob'),
      fakeEntry('object', 'public/readme.txt'),
    ];

    function GatedBrowser({ storage }: { storage: FirebaseStorage }) {
      const gate = useStorageRulesGate(storage);
      return <ObjectBrowser entries={GATE_ENTRIES} gate={gate} />;
    }

    function makeRuledSandbox(label: string) {
      const sandbox = initializeSandbox({});
      const dbName = `pyric-ui-browser-gate-${label}-${Math.random().toString(36).slice(2, 10)}`;
      const alice = getStorageSandbox(sandbox.withAuth({ uid: 'alice' }), {
        dbName,
        rules: OWNER_RULES,
      });
      const bob = getStorageSandbox(sandbox.withAuth({ uid: 'bob' }), { dbName });
      return { alice, bob };
    }

    it('stamps data-pyric-denied (+ reason) on read-denied rows', async () => {
      const { alice } = makeRuledSandbox('stamp');
      const { container } = render(<GatedBrowser storage={alice} />);

      // The gate resolves the deployed ruleset async — denied stamps
      // appear once ready (fails open before that).
      await waitFor(() =>
        expect(
          container.querySelector('[data-pyric-entry-path="users/bob"]')!
            .hasAttribute('data-pyric-denied'),
        ).toBe(true),
      );

      const bobRow = container.querySelector('[data-pyric-entry-path="users/bob"]')!;
      expect(bobRow.getAttribute('data-pyric-denied-reason')).toContain('users/{uid}');

      // Alice's own tree and the public read tree stay un-stamped.
      expect(
        container.querySelector('[data-pyric-entry-path="users/alice"]')!
          .hasAttribute('data-pyric-denied'),
      ).toBe(false);
      expect(
        container.querySelector('[data-pyric-entry-path="public/readme.txt"]')!
          .hasAttribute('data-pyric-denied'),
      ).toBe(false);
    });

    it('denied stamps flip with identity (same sandbox, other context)', async () => {
      const { bob } = makeRuledSandbox('flip');
      const { container } = render(<GatedBrowser storage={bob} />);

      await waitFor(() =>
        expect(
          container.querySelector('[data-pyric-entry-path="users/alice"]')!
            .hasAttribute('data-pyric-denied'),
        ).toBe(true),
      );
      expect(
        container.querySelector('[data-pyric-entry-path="users/bob"]')!
          .hasAttribute('data-pyric-denied'),
      ).toBe(false);
    });
  });
});

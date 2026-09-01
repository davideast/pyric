// Install JSDOM globals before importing React or RTL.
import { JSDOM } from 'jsdom';
const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>', {
  pretendToBeVisual: true,
  url: 'http://localhost/storage/avatars?kind=prefix',
});
const g = globalThis as any;
g.window = dom.window;
g.document = dom.window.document;
g.HTMLElement = dom.window.HTMLElement;
g.Element = dom.window.Element;
g.Node = dom.window.Node;
g.Event = dom.window.Event;
g.ResizeObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
};
g.getComputedStyle = dom.window.getComputedStyle.bind(dom.window);
g.IS_REACT_ACT_ENVIRONMENT = true;

import {
  indexedDB as fakeIndexedDB,
  IDBKeyRange as fakeIDBKeyRange,
} from 'fake-indexeddb';
g.indexedDB = fakeIndexedDB;
g.IDBKeyRange = fakeIDBKeyRange;

import { afterEach, describe, expect, it } from 'bun:test';
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { initializeSandbox } from 'pyric/sandbox';
import {
  getStorageSandbox,
  ref,
  uploadBytes,
  type FirebaseStorage,
} from 'pyric/storage';
import { TrafficRow } from '@pyric/ui/traffic';
import { LiveStoragePane } from '../../../src/features/data/StoragePane.js';
import { useDataNav } from '../../../src/features/data/navigation.js';
import { pushPath } from '../../../src/shell/router.js';
import {
  subjectTarget,
  type StudioTrafficEvent,
} from '../../../src/features/traffic/verdict.js';

afterEach(() => cleanup());

const OPEN_STORAGE_RULES = `
service firebase.storage {
  match /b/{bucket}/o {
    match /{path=**} { allow read, write: if true; }
  }
}`;

function makeStorage(): FirebaseStorage {
  const sandbox = initializeSandbox({});
  return getStorageSandbox(sandbox, {
    dbName: `pyric-studio-storage-nav-${Math.random().toString(36).slice(2, 10)}`,
    rules: OPEN_STORAGE_RULES,
  });
}

function RoutedStoragePane({ storage }: { storage: FirebaseStorage }) {
  const { target } = useDataNav();
  return (
    <LiveStoragePane
      storage={storage}
      focusTarget={target?.view === 'storage' ? target : { kind: 'root' }}
    />
  );
}

const LIST_AVATARS = {
  id: 'storage-list-avatars',
  kind: 'operation',
  service: 'storage',
  method: 'list',
  path: 'avatars',
  at: 1,
  durationMs: 1,
  auth: null,
  result: 'allow',
  origin: 'client',
  reasons: [],
  operationContext: {
    source: { kind: 'app' },
    authLens: { mode: 'app-session' },
  },
  rulesDisposition: { kind: 'evaluated', verdict: 'allow' },
} as StudioTrafficEvent;

const LIST_ROOT = {
  ...LIST_AVATARS,
  id: 'storage-list-root',
  path: '',
} as StudioTrafficEvent;

function StorageListTrafficRow({
  event = LIST_AVATARS,
}: {
  event?: StudioTrafficEvent;
}) {
  return (
    <TrafficRow
      event={event}
      onSelect={(event) => {
        const target = subjectTarget(event as StudioTrafficEvent);
        if (target) pushPath(target);
      }}
    />
  );
}

describe('Storage route intent', () => {
  it('opens a listed prefix when its Traffic row is clicked', async () => {
    const storage = makeStorage();
    await uploadBytes(ref(storage, 'avatars/alice.png'), new Uint8Array([1]));
    window.history.replaceState(null, '', '/traffic');

    const view = render(
      <>
        <StorageListTrafficRow />
        <RoutedStoragePane storage={storage} />
      </>,
    );
    fireEvent.click(view.container.querySelector('[data-pyric-traffic-row]')!);

    expect(window.location.pathname + window.location.search).toBe(
      '/storage/avatars?kind=prefix',
    );
    await waitFor(() =>
      expect(
        view.container.querySelector('[data-pyric-entry-path="avatars/alice.png"]'),
      ).not.toBeNull(),
    );
    expect(
      view.container.querySelector('[data-pyric-ui="object-inspector"][data-pyric-error]'),
    ).toBeNull();
  });

  it('labels a Storage root list as slash and opens the bucket root', async () => {
    const storage = makeStorage();
    await uploadBytes(ref(storage, 'avatars/alice.png'), new Uint8Array([1]));
    window.history.replaceState(null, '', '/traffic');

    const view = render(
      <>
        <StorageListTrafficRow event={LIST_ROOT} />
        <RoutedStoragePane storage={storage} />
      </>,
    );
    const row = view.container.querySelector('[data-pyric-traffic-row]')!;
    expect(row.querySelector('[data-pyric-traffic-path]')!.textContent).toBe('/');

    fireEvent.click(row);
    expect(window.location.pathname + window.location.search).toBe('/storage');
    await waitFor(() =>
      expect(
        view.container.querySelector(
          '[data-pyric-entry-kind="folder"][data-pyric-entry-path="avatars"]',
        ),
      ).not.toBeNull(),
    );
  });

  it('browses a prefix and inspects an object at the identical path', async () => {
    const storage = makeStorage();
    await uploadBytes(ref(storage, 'avatars'), new Blob(['object-at-the-prefix-path']));
    await uploadBytes(ref(storage, 'avatars/alice.png'), new Uint8Array([1]), {
      contentType: 'application/octet-stream',
    });

    const view = render(
      <LiveStoragePane
        storage={storage}
        focusTarget={{ kind: 'prefix', path: 'avatars' }}
      />,
    );

    await waitFor(() =>
      expect(
        view.container.querySelector('[data-pyric-entry-path="avatars/alice.png"]'),
      ).not.toBeNull(),
    );
    expect(view.container.querySelector('[data-pyric-object-metadata]')).toBeNull();

    view.rerender(
      <LiveStoragePane
        storage={storage}
        focusTarget={{ kind: 'object', path: 'avatars' }}
      />,
    );

    await waitFor(() =>
      expect(
        view.container.querySelector('[data-pyric-metadata-field="fullPath"] dd')
          ?.textContent,
      ).toContain('/avatars'),
    );
  });

  it('restores prefix browsing through browser back navigation', async () => {
    const storage = makeStorage();
    await uploadBytes(ref(storage, 'avatars/alice.png'), new Uint8Array([1]), {
      contentType: 'application/octet-stream',
    });
    window.history.replaceState(null, '', '/storage/avatars?kind=prefix');

    const view = render(<RoutedStoragePane storage={storage} />);
    const aliceRow = await waitFor(() => {
      const row = view.container.querySelector(
        '[data-pyric-entry-path="avatars/alice.png"]',
      );
      expect(row).not.toBeNull();
      return row!;
    });

    fireEvent.click(aliceRow.querySelector('[data-pyric-entry-select]')!);
    expect(window.location.pathname + window.location.search).toBe(
      '/storage/avatars/alice.png',
    );
    await waitFor(() =>
      expect(view.container.querySelector('[data-pyric-object-metadata]')).not.toBeNull(),
    );

    window.history.back();
    await waitFor(() =>
      expect(window.location.pathname + window.location.search).toBe(
        '/storage/avatars?kind=prefix',
      ),
    );
    await waitFor(() =>
      expect(
        view.container.querySelector('[data-pyric-entry-path="avatars/alice.png"]'),
      ).not.toBeNull(),
    );
    expect(view.container.querySelector('[data-pyric-object-metadata]')).toBeNull();
  });
});

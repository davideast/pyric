// Install JSDOM globals before importing React or RTL.
import { JSDOM } from 'jsdom';

const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>', {
  pretendToBeVisual: true,
  url: 'http://localhost/storage',
});
const g = globalThis as Record<string, unknown>;
g.window = dom.window;
g.document = dom.window.document;
g.navigator = dom.window.navigator;
g.HTMLElement = dom.window.HTMLElement;
g.HTMLButtonElement = dom.window.HTMLButtonElement;
g.Element = dom.window.Element;
g.Node = dom.window.Node;
g.Event = dom.window.Event;
g.MouseEvent = dom.window.MouseEvent;
g.ResizeObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
};
g.getComputedStyle = dom.window.getComputedStyle.bind(dom.window);
g.IS_REACT_ACT_ENVIRONMENT = true;

import { afterEach, describe, expect, it } from 'bun:test';
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { StorageApiProvider, type StorageApi } from '@pyric/ui/storage';
import type { FirebaseStorage, FullMetadata, ListResult, StorageReference } from 'pyric/storage';
import { LiveObservedStoragePane } from '../../../src/features/data/LiveObservedStoragePane.js';

afterEach(() => cleanup());

const STORAGE_HANDLE = { app: { name: '[LIVE]' } } as unknown as FirebaseStorage;

function makeRef(bucket: string, fullPath: string): StorageReference {
  const idx = fullPath.lastIndexOf('/');
  const name = idx === -1 ? fullPath : fullPath.slice(idx + 1);
  return {
    bucket,
    fullPath,
    name,
    storage: STORAGE_HANDLE,
    parent: null,
    root: null,
    toString: () => `gs://${bucket}/${fullPath}`,
  } as unknown as StorageReference;
}

describe('LiveObservedStoragePane', () => {
  it('renders honest empty state, zero phantom bucket tabs, and zero write controls when no Storage traffic is observed', async () => {
    const emptyApi: StorageApi = {
      ref: (_s, p) => makeRef('', p ?? ''),
      listAll: async (): Promise<ListResult> => ({ items: [], prefixes: [] }),
      getMetadata: async (): Promise<FullMetadata> => {
        throw new Error('not found');
      },
      getBlob: async () => {
        throw new Error('getBlob should never run');
      },
      uploadBytes: (async () => {
        throw new Error('refused');
      }) as unknown as StorageApi['uploadBytes'],
      uploadBytesResumable: (() => {
        throw new Error('refused');
      }) as unknown as StorageApi['uploadBytesResumable'],
      deleteObject: async () => {
        throw new Error('refused');
      },
    };

    const view = render(
      <StorageApiProvider value={emptyApi}>
        <LiveObservedStoragePane
          storage={STORAGE_HANDLE}
          activeBucket=""
          bucketSummaries={[]}
          onSelectBucket={() => {}}
          bucketCatalog={undefined}
          hasObservedStorage={false}
          focusTarget={{ kind: 'root' }}
        />
      </StorageApiProvider>,
    );

    await waitFor(() =>
      expect(view.container.querySelector('[data-storage-live-empty]')?.textContent).toContain(
        'No Storage reads, listings, or uploads observed in this live session yet.',
      ),
    );
    expect(view.container.querySelector('[data-storage-bucket-bar]')).toBeNull();
    expect(view.container.querySelector('[data-live-storage-readonly-badge]')?.textContent).toContain(
      'Observed metadata only · Zero bytes retained',
    );
    expect(view.container.querySelector('input[type="file"]')).toBeNull();
    expect(view.container.querySelector('input[type="checkbox"]')).toBeNull();
    expect(view.container.textContent).not.toContain('Upload files');
    expect(view.container.textContent).not.toContain('New folder');
  });

  it('browses observed objects, renders deleted tombstones, Copy gs:// URI / Copy path controls, token-free Storage URL, and never calls getBlob', async () => {
    let getBlobCalls = 0;
    const bucket = 'demo.firebasestorage.app';
    const catalog = {
      prefixes: ['workspaces/ws-1/items'],
      deleted: ['workspaces/ws-1/items/deleted-draft.png'],
      objects: {
        'workspaces/ws-1/items/item-1.png': {
          bucket,
          fullPath: 'workspaces/ws-1/items/item-1.png',
          name: 'item-1.png',
          size: 2048,
          contentType: 'image/png',
          timeCreated: '2026-01-01T00:00:00.000Z',
          updated: '2026-01-02T00:00:00.000Z',
          customMetadata: {
            owner: 'u1',
            firebaseStorageDownloadTokens: '[REDACTED]',
          },
          downloadUrl:
            'https://firebasestorage.googleapis.com/v0/b/demo.firebasestorage.app/o/item-1.png?alt=media',
        },
        'workspaces/ws-1/items/server-report.json': {
          bucket,
          fullPath: 'workspaces/ws-1/items/server-report.json',
          name: 'server-report.json',
          size: 512,
          contentType: 'application/json',
          customMetadata: {
            apiKey: '[REDACTED]',
          },
        },
      },
    };

    const api: StorageApi = {
      ref: (_s, p) => makeRef(bucket, (p ?? '').replace(/^\/+|\/+$/g, '')),
      listAll: async (target): Promise<ListResult> => {
        if (target.fullPath === 'workspaces/ws-1/items') {
          return {
            prefixes: [],
            items: [
              makeRef(bucket, 'workspaces/ws-1/items/item-1.png'),
              makeRef(bucket, 'workspaces/ws-1/items/server-report.json'),
            ],
          };
        }
        return { prefixes: [makeRef(bucket, 'workspaces')], items: [] };
      },
      getMetadata: async (target): Promise<FullMetadata> => {
        const obs = catalog.objects[target.fullPath as keyof typeof catalog.objects];
        return {
          bucket,
          fullPath: obs.fullPath,
          name: obs.name,
          size: obs.size,
          contentType: obs.contentType,
          timeCreated: 'timeCreated' in obs ? obs.timeCreated : '',
          updated: 'updated' in obs ? obs.updated : '',
          generation: '1',
          metageneration: '1',
          customMetadata: obs.customMetadata,
        };
      },
      getBlob: async () => {
        getBlobCalls += 1;
        throw new Error('getBlob must never be called in Live mode');
      },
      uploadBytes: (async () => {
        throw new Error('refused');
      }) as unknown as StorageApi['uploadBytes'],
      uploadBytesResumable: (() => {
        throw new Error('refused');
      }) as unknown as StorageApi['uploadBytesResumable'],
      deleteObject: async () => {
        throw new Error('refused');
      },
    };

    const summaries = [
      { bucket, observed: true, isDefault: true, objectCount: 2, prefixCount: 1, deletedCount: 1 },
      {
        bucket: 'archive-bucket',
        observed: true,
        isDefault: false,
        objectCount: 1,
        prefixCount: 0,
        deletedCount: 0,
      },
    ];

    let selectedBucket = bucket;
    const view = render(
      <StorageApiProvider value={api}>
        <LiveObservedStoragePane
          storage={STORAGE_HANDLE}
          activeBucket={bucket}
          bucketSummaries={summaries}
          onSelectBucket={(next) => {
            selectedBucket = next;
          }}
          bucketCatalog={catalog}
          hasObservedStorage
          focusTarget={{ kind: 'object', path: 'workspaces/ws-1/items/item-1.png' }}
        />
      </StorageApiProvider>,
    );

    await waitFor(() =>
      expect(view.container.querySelector('[data-live-storage-no-bytes]')).not.toBeNull(),
    );
    expect(getBlobCalls).toBe(0);
    expect(view.container.querySelector('[data-live-storage-credentials-stripped]')?.textContent).toContain(
      'stripped at capture time',
    );
    const copyGsBtn = view.container.querySelector('[data-live-storage-copy-gs-uri]')!;
    fireEvent.click(copyGsBtn);
    expect(copyGsBtn.textContent).toContain('Copied gs:// URI');
    const copyPathBtn = view.container.querySelector('[data-live-storage-copy-path]')!;
    fireEvent.click(copyPathBtn);
    expect(copyPathBtn.textContent).toContain('Copied path');

    const link = view.container.querySelector(
      '[data-live-storage-download-url]',
    ) as HTMLAnchorElement | null;
    expect(link).not.toBeNull();
    expect(link?.getAttribute('href')).toBe(
      'https://firebasestorage.googleapis.com/v0/b/demo.firebasestorage.app/o/item-1.png?alt=media',
    );
    expect(link?.getAttribute('href')).not.toContain('token=');
    expect(link?.getAttribute('target')).toBe('_blank');
    expect(view.container.querySelector('[data-live-storage-external-notice]')?.textContent).toContain(
      'without embedded bearer credentials',
    );
    expect(
      view.container.querySelector(
        '[data-live-storage-deleted-path="workspaces/ws-1/items/deleted-draft.png"]',
      ),
    ).not.toBeNull();
    expect(
      view.container.querySelector(
        '[data-pyric-metadata-key="firebaseStorageDownloadTokens"] dd',
      )?.textContent,
    ).toBe('[REDACTED]');

    view.rerender(
      <StorageApiProvider value={api}>
        <LiveObservedStoragePane
          storage={STORAGE_HANDLE}
          activeBucket={bucket}
          bucketSummaries={summaries}
          onSelectBucket={(next) => {
            selectedBucket = next;
          }}
          bucketCatalog={catalog}
          hasObservedStorage
          focusTarget={{ kind: 'object', path: 'workspaces/ws-1/items/server-report.json' }}
        />
      </StorageApiProvider>,
    );

    await waitFor(() =>
      expect(
        view.container.querySelector('[data-pyric-metadata-key="apiKey"] dd')?.textContent,
      ).toBe('[REDACTED]'),
    );
    expect(view.container.querySelector('[data-live-storage-download-url]')).toBeNull();
    expect(getBlobCalls).toBe(0);

    fireEvent.click(view.container.querySelector('[data-storage-bucket="archive-bucket"]')!);
    expect(selectedBucket).toBe('archive-bucket');
  });
});

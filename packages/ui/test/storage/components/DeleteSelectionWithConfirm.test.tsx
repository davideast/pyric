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

// Real sandbox behind the component (no rules in DOM tests — see
// ObjectInspector.test.tsx; the failure path injects a failing impl
// instead). Explicit global assignment: fake-indexeddb/auto targets
// `window` when another DOM file installed one first.
import { indexedDB as fakeIndexedDB, IDBKeyRange as fakeIDBKeyRange } from 'fake-indexeddb';
g.indexedDB = fakeIndexedDB;
g.IDBKeyRange = fakeIDBKeyRange;

import { afterEach, describe, it, expect } from 'bun:test';
import { render, cleanup, fireEvent, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { initializeSandbox } from 'pyric/sandbox';
import {
  getStorageSandbox,
  listAll,
  ref,
  uploadBytes,
  type FirebaseStorage,
} from 'pyric/storage';
import { ConfirmProvider } from '../../../src/primitives/useConfirm.js';
import { ToastProvider } from '../../../src/primitives/Toast.js';
import {
  DeleteSelectionWithConfirm,
  useStorageRulesGate,
  type StorageRecursiveDeleteImpl,
} from '../../../src/storage/index.js';

afterEach(() => cleanup());

function makeStorage(label: string): FirebaseStorage {
  const sandbox = initializeSandbox({});
  return getStorageSandbox(sandbox, {
    dbName: `pyric-ui-delsel-${label}-${Math.random().toString(36).slice(2, 10)}`,
  });
}

function withProviders(node: ReactNode) {
  return (
    <ToastProvider>
      <ConfirmProvider>{node}</ConfirmProvider>
    </ToastProvider>
  );
}

const q = (sel: string) => document.body.querySelector(sel);

describe('DeleteSelectionWithConfirm', () => {
  it('disables the default trigger for an empty selection', () => {
    render(
      withProviders(
        <DeleteSelectionWithConfirm storage={makeStorage('empty')} entries={[]} />,
      ),
    );
    const trigger = q('[data-pyric-ui="delete-selection"]') as HTMLButtonElement;
    expect(trigger.disabled).toBe(true);
    expect(trigger.hasAttribute('data-pyric-destructive')).toBe(true);
  });

  it('cancel keeps everything: no delete, no toast', async () => {
    const storage = makeStorage('cancel');
    await uploadBytes(ref(storage, 'docs/a.txt'), new Blob(['a']));
    render(
      withProviders(
        <DeleteSelectionWithConfirm
          storage={storage}
          entries={[{ kind: 'object', fullPath: 'docs/a.txt' }]}
        />,
      ),
    );

    fireEvent.click(q('[data-pyric-ui="delete-selection"]')!);
    await waitFor(() => expect(q('[data-pyric-ui="confirm-dialog"]')).not.toBeNull());
    // The default body lists the selected paths.
    expect(q('[data-pyric-delete-selection-paths]')!.textContent).toContain(
      'docs/a.txt',
    );
    fireEvent.click(q('[data-pyric-confirm-cancel]')!);
    await waitFor(() => expect(q('[data-pyric-ui="confirm-dialog"]')).toBeNull());

    await new Promise((r) => setTimeout(r, 20));
    expect(q('[data-pyric-toast]')).toBeNull();
    const listed = await listAll(ref(storage, 'docs'));
    expect(listed.items.length).toBe(1);
  });

  it('confirm deletes the selection and toasts success', async () => {
    const storage = makeStorage('confirm');
    await uploadBytes(ref(storage, 'docs/a.txt'), new Blob(['a']));
    await uploadBytes(ref(storage, 'docs/sub/b.txt'), new Blob(['b']));
    const outcomes: unknown[] = [];

    render(
      withProviders(
        <DeleteSelectionWithConfirm
          storage={storage}
          entries={[
            { kind: 'object', fullPath: 'docs/a.txt' },
            { kind: 'folder', fullPath: 'docs/sub' },
          ]}
          onDeleted={(o) => outcomes.push(o)}
        />,
      ),
    );

    fireEvent.click(q('[data-pyric-ui="delete-selection"]')!);
    await waitFor(() => expect(q('[data-pyric-ui="confirm-dialog"]')).not.toBeNull());
    expect(q('[data-pyric-confirm-title]')!.textContent).toBe('Delete 2 items?');
    fireEvent.click(q('[data-pyric-confirm-confirm]')!);

    await waitFor(() =>
      expect(q('[data-pyric-toast][data-pyric-toast-kind="success"]')).not.toBeNull(),
    );
    expect(q('[data-pyric-toast-title]')!.textContent).toBe('Deleted 2 items');
    expect(outcomes.length).toBe(1);
    const listed = await listAll(ref(storage, 'docs'));
    expect(listed.items).toEqual([]);
    expect(listed.prefixes).toEqual([]);
  });

  it('failures toast an error listing each failed path', async () => {
    const storage = makeStorage('failure');
    await uploadBytes(ref(storage, 'docs/sub/b.txt'), new Blob(['b']));
    const boom: StorageRecursiveDeleteImpl = {
      start: async function* (): AsyncIterableIterator<never> {
        throw Object.assign(new Error('denied'), { code: 'storage/unauthorized' });
      },
    };
    const failed: unknown[] = [];

    render(
      withProviders(
        <DeleteSelectionWithConfirm
          storage={storage}
          entries={[{ kind: 'folder', fullPath: 'docs/sub' }]}
          impl={boom}
          onFailed={(o) => failed.push(o)}
        />,
      ),
    );

    fireEvent.click(q('[data-pyric-ui="delete-selection"]')!);
    await waitFor(() => expect(q('[data-pyric-ui="confirm-dialog"]')).not.toBeNull());
    fireEvent.click(q('[data-pyric-confirm-confirm]')!);

    await waitFor(() =>
      expect(q('[data-pyric-toast][data-pyric-toast-kind="error"]')).not.toBeNull(),
    );
    // The toast body carries the typed code per failed path.
    expect(q('[data-pyric-delete-selection-failures]')!.textContent).toBe(
      'docs/sub: storage/unauthorized',
    );
    expect(failed.length).toBe(1);
    // Nothing was deleted.
    const listed = await listAll(ref(storage, 'docs/sub'));
    expect(listed.items.length).toBe(1);
  });

  it('renderTrigger overrides the default button', async () => {
    const storage = makeStorage('trigger');
    render(
      withProviders(
        <DeleteSelectionWithConfirm
          storage={storage}
          entries={[{ kind: 'object', fullPath: 'docs/a.txt' }]}
          renderTrigger={({ onClick, disabled }) => (
            <a data-custom-trigger data-disabled={disabled} onClick={onClick}>
              Trash it
            </a>
          )}
        />,
      ),
    );
    expect(q('[data-pyric-ui="delete-selection"]')).toBeNull();
    fireEvent.click(q('[data-custom-trigger]')!);
    await waitFor(() => expect(q('[data-pyric-ui="confirm-dialog"]')).not.toBeNull());
  });

  describe('rules gate affordances (M7)', () => {
    // Owner-only rules, deployed onto a REAL sandbox the standard way
    // (first factory call wins). The storage rules parser is the
    // hand-rolled one — safe under JSDOM, unlike the firestore OHM
    // parser the file header warns about.
    function makeRuledStorage(label: string, uid: string): FirebaseStorage {
      const sandbox = initializeSandbox({});
      return getStorageSandbox(sandbox.withAuth({ uid }), {
        dbName: `pyric-ui-delsel-gate-${label}-${Math.random().toString(36).slice(2, 10)}`,
        rules: `
service firebase.storage {
  match /users/{uid}/{allPaths=**} {
    allow read, write: if request.auth != null && request.auth.uid == uid;
  }
}`,
      });
    }

    function GatedDelete({
      storage,
      paths,
    }: {
      storage: FirebaseStorage;
      paths: string[];
    }) {
      const gate = useStorageRulesGate(storage);
      return (
        <DeleteSelectionWithConfirm
          storage={storage}
          gate={gate}
          entries={paths.map((p) => ({ kind: 'object' as const, fullPath: p }))}
        />
      );
    }

    it('disables with the denial reason when ANY selected entry is delete-denied', async () => {
      const storage = makeRuledStorage('denied', 'alice');
      render(
        withProviders(
          <GatedDelete
            storage={storage}
            paths={['users/alice/mine.txt', 'users/bob/theirs.txt']}
          />,
        ),
      );

      const trigger = q('[data-pyric-ui="delete-selection"]') as HTMLButtonElement;
      // The gate resolves async; the denial lands once ready.
      await waitFor(() => expect(trigger.hasAttribute('data-pyric-denied')).toBe(true));
      expect(trigger.disabled).toBe(true);
      const reason = trigger.getAttribute('data-pyric-denied-reason')!;
      expect(reason).toContain('users/bob/theirs.txt');
      expect(reason).toContain('condition false');
      expect(trigger.getAttribute('title')).toBe(reason);
    });

    it('stays enabled for an owned selection — verdicts flip with identity', async () => {
      const storage = makeRuledStorage('allowed', 'bob');
      render(
        withProviders(
          <GatedDelete storage={storage} paths={['users/bob/theirs.txt']} />,
        ),
      );
      const trigger = q('[data-pyric-ui="delete-selection"]') as HTMLButtonElement;
      // Let the gate resolve; the verdict allows, so no denial state.
      await new Promise((r) => setTimeout(r, 30));
      expect(trigger.hasAttribute('data-pyric-denied')).toBe(false);
      expect(trigger.disabled).toBe(false);
    });

    it('renderTrigger receives the deniedReason', async () => {
      const storage = makeRuledStorage('render-trigger', 'alice');
      function Custom({ storage: s }: { storage: FirebaseStorage }) {
        const gate = useStorageRulesGate(s);
        return (
          <DeleteSelectionWithConfirm
            storage={s}
            gate={gate}
            entries={[{ kind: 'object', fullPath: 'users/bob/x.txt' }]}
            renderTrigger={({ disabled, deniedReason }) => (
              <a data-custom-trigger data-disabled={disabled}>
                {deniedReason ?? 'Delete'}
              </a>
            )}
          />
        );
      }
      render(withProviders(<Custom storage={storage} />));
      await waitFor(() =>
        expect(q('[data-custom-trigger]')!.textContent).toContain(
          'users/bob/x.txt',
        ),
      );
    });
  });
});

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

// Real sandbox behind the rules-gate probe. Storage rules use the
// hand-rolled `@pyric/storage` parser (NOT the firestore OHM one), so
// deploying rules in a DOM test is safe. Explicit global assignment —
// see ObjectInspector.test.tsx for the shared-process rationale.
import { indexedDB as fakeIndexedDB, IDBKeyRange as fakeIDBKeyRange } from 'fake-indexeddb';
g.indexedDB = fakeIndexedDB;
g.IDBKeyRange = fakeIDBKeyRange;

import { afterEach, describe, it, expect } from 'bun:test';
import { render, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { initializeSandbox } from 'pyric/sandbox';
import { getStorageSandbox, type FirebaseStorage } from 'pyric/storage';
import {
  UploadDropzone,
  useStorageRulesGate,
  type DroppedFile,
} from '../../../src/storage/index.js';

afterEach(() => cleanup());

// jsdom has no real drag-and-drop — we drive the component with
// synthetic DataTransfer shapes (plain objects; the component only
// touches the documented surface: items[].kind / webkitGetAsEntry /
// getAsFile, files, FileSystemEntry.file / createReader.readEntries).

function fakeFileEntry(name: string, contents = 'x') {
  const file = new File([contents], name);
  return {
    isFile: true,
    isDirectory: false,
    name,
    file: (resolve: (f: File) => void) => resolve(file),
  };
}

/** Directory entry whose children arrive in `batches` — mirrors
 *  Chrome's readEntries batching (a final empty batch ends the walk). */
function fakeDirEntry(name: string, batches: unknown[][]) {
  let i = 0;
  return {
    isFile: false,
    isDirectory: true,
    name,
    createReader: () => ({
      readEntries: (resolve: (entries: unknown[]) => void) => {
        resolve(i < batches.length ? (batches[i++] as unknown[]) : []);
      },
    }),
  };
}

function fileItem(entry: unknown) {
  return { kind: 'file', webkitGetAsEntry: () => entry };
}

describe('UploadDropzone', () => {
  it('renders the children slot and the structural attribute', () => {
    const { container } = render(
      <UploadDropzone onFiles={() => {}}>
        <p>Drop files here</p>
      </UploadDropzone>,
    );
    const root = container.querySelector('[data-pyric-ui="upload-dropzone"]')!;
    expect(root.textContent).toBe('Drop files here');
    expect(root.hasAttribute('data-dragging')).toBe(false);
  });

  it('stamps data-dragging across nested enter/leave pairs', () => {
    const { container } = render(
      <UploadDropzone onFiles={() => {}}>
        <span>inner</span>
      </UploadDropzone>,
    );
    const root = container.querySelector('[data-pyric-ui="upload-dropzone"]') as HTMLElement;
    const inner = root.querySelector('span')!;

    fireEvent.dragEnter(root);
    expect(root.hasAttribute('data-dragging')).toBe(true);
    // Crossing into a child fires enter(child) then leave(root) — the
    // depth counter keeps the state on.
    fireEvent.dragEnter(inner);
    fireEvent.dragLeave(root);
    expect(root.hasAttribute('data-dragging')).toBe(true);
    // Leaving entirely clears it.
    fireEvent.dragLeave(inner);
    expect(root.hasAttribute('data-dragging')).toBe(false);
  });

  it('delivers plain file drops via the files fallback (no items)', async () => {
    const received: DroppedFile[][] = [];
    const { container } = render(<UploadDropzone onFiles={(f) => received.push(f)} />);
    const root = container.querySelector('[data-pyric-ui="upload-dropzone"]') as HTMLElement;

    fireEvent.drop(root, {
      dataTransfer: { files: [new File(['a'], 'a.txt'), new File(['b'], 'b.txt')] },
    });

    await waitFor(() => expect(received.length).toBe(1));
    expect(received[0].map((f) => f.relativePath)).toEqual(['a.txt', 'b.txt']);
    expect(received[0][0].file.name).toBe('a.txt');
    // Drop clears the dragging state.
    expect(root.hasAttribute('data-dragging')).toBe(false);
  });

  it('prefers webkitGetAsEntry items and resolves file entries', async () => {
    const received: DroppedFile[][] = [];
    const { container } = render(<UploadDropzone onFiles={(f) => received.push(f)} />);
    const root = container.querySelector('[data-pyric-ui="upload-dropzone"]') as HTMLElement;

    fireEvent.drop(root, {
      dataTransfer: {
        items: [fileItem(fakeFileEntry('one.txt')), fileItem(fakeFileEntry('two.txt'))],
        files: [],
      },
    });

    await waitFor(() => expect(received.length).toBe(1));
    expect(received[0].map((f) => f.relativePath)).toEqual(['one.txt', 'two.txt']);
  });

  it('walks folder drops recursively with folder-relative paths (batched readEntries)', async () => {
    const received: DroppedFile[][] = [];
    const { container } = render(<UploadDropzone onFiles={(f) => received.push(f)} />);
    const root = container.querySelector('[data-pyric-ui="upload-dropzone"]') as HTMLElement;

    const tree = fakeDirEntry('photos', [
      // Two batches pin the readEntries loop (Chrome caps batches).
      [fakeFileEntry('cat.png'), fakeDirEntry('raw', [[fakeFileEntry('cat.cr2')]])],
      [fakeFileEntry('dog.png')],
    ]);
    fireEvent.drop(root, {
      dataTransfer: { items: [fileItem(tree), fileItem(fakeFileEntry('note.txt'))], files: [] },
    });

    await waitFor(() => expect(received.length).toBe(1));
    expect(received[0].map((f) => f.relativePath)).toEqual([
      'photos/cat.png',
      'photos/raw/cat.cr2',
      'photos/dog.png',
      'note.txt',
    ]);
  });

  it('falls back to getAsFile for items without entry support', async () => {
    const received: DroppedFile[][] = [];
    const { container } = render(<UploadDropzone onFiles={(f) => received.push(f)} />);
    const root = container.querySelector('[data-pyric-ui="upload-dropzone"]') as HTMLElement;

    fireEvent.drop(root, {
      dataTransfer: {
        items: [{ kind: 'file', getAsFile: () => new File(['x'], 'plain.txt') }],
        files: [],
      },
    });

    await waitFor(() => expect(received.length).toBe(1));
    expect(received[0].map((f) => f.relativePath)).toEqual(['plain.txt']);
  });

  it('ignores empty drops and non-file items', async () => {
    const received: DroppedFile[][] = [];
    const { container } = render(<UploadDropzone onFiles={(f) => received.push(f)} />);
    const root = container.querySelector('[data-pyric-ui="upload-dropzone"]') as HTMLElement;

    fireEvent.drop(root, {
      dataTransfer: { items: [{ kind: 'string' }], files: [] },
    });
    // Give the async collector a tick to (not) fire.
    await new Promise((r) => setTimeout(r, 20));
    expect(received).toEqual([]);
  });

  it('disabled: stamps data-disabled, suppresses dragging and drops', async () => {
    const received: DroppedFile[][] = [];
    const { container } = render(
      <UploadDropzone disabled onFiles={(f) => received.push(f)} />,
    );
    const root = container.querySelector('[data-pyric-ui="upload-dropzone"]') as HTMLElement;
    expect(root.hasAttribute('data-disabled')).toBe(true);

    fireEvent.dragEnter(root);
    expect(root.hasAttribute('data-dragging')).toBe(false);
    fireEvent.drop(root, { dataTransfer: { files: [new File(['a'], 'a.txt')] } });
    await new Promise((r) => setTimeout(r, 20));
    expect(received).toEqual([]);
  });

  it('stamps the disabled reason (and aria-disabled) only while disabled', () => {
    const { container, rerender } = render(
      <UploadDropzone disabled disabledReason="write denied" onFiles={() => {}} />,
    );
    const root = container.querySelector('[data-pyric-ui="upload-dropzone"]') as HTMLElement;
    expect(root.getAttribute('data-disabled-reason')).toBe('write denied');
    expect(root.getAttribute('aria-disabled')).toBe('true');

    rerender(<UploadDropzone disabledReason="write denied" onFiles={() => {}} />);
    expect(root.hasAttribute('data-disabled-reason')).toBe(false);
    expect(root.hasAttribute('aria-disabled')).toBe(false);
  });

  it('disables with the gate verdict reason against REAL deployed rules (M7)', async () => {
    // Owner-only rules deployed the standard way (first factory call
    // per sandbox wins); the anonymous context's write verdict denies.
    const sandbox = initializeSandbox({});
    const dbName = `pyric-ui-dropzone-gate-${Math.random().toString(36).slice(2, 10)}`;
    const owner = getStorageSandbox(sandbox.withAuth({ uid: 'alice' }), {
      dbName,
      rules: `
service firebase.storage {
  match /users/{uid}/{allPaths=**} {
    allow read, write: if request.auth != null && request.auth.uid == uid;
  }
}`,
    });
    const anon = getStorageSandbox(sandbox.withAuth(null), { dbName });

    function GatedDropzone({ storage }: { storage: FirebaseStorage }) {
      const gate = useStorageRulesGate(storage);
      const verdict = gate.verdictFor('users/alice/upload.txt');
      return (
        <UploadDropzone
          onFiles={() => {}}
          disabled={!verdict.upload}
          disabledReason={verdict.reasons.write.join('; ')}
        />
      );
    }

    const { container } = render(<GatedDropzone storage={anon} />);
    const root = container.querySelector('[data-pyric-ui="upload-dropzone"]') as HTMLElement;
    // The gate fails open while loading, then the denial lands.
    await waitFor(() => expect(root.hasAttribute('data-disabled')).toBe(true));
    expect(root.getAttribute('data-disabled-reason')).toContain('condition false');

    // The owner's context stays enabled — verdicts flip with identity.
    const { container: ownerC } = render(<GatedDropzone storage={owner} />);
    const ownerRoot = ownerC.querySelector('[data-pyric-ui="upload-dropzone"]') as HTMLElement;
    await new Promise((r) => setTimeout(r, 30));
    expect(ownerRoot.hasAttribute('data-disabled')).toBe(false);
  });
});

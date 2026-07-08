// Install JSDOM globals before importing React or RTL.
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
import { initializeSandbox } from 'pyric/sandbox';
import {
  collection as collFn,
  getFirestore,
  type CollectionReference,
  type DocumentReference,
} from 'pyric/firestore';
import { ReferencePicker } from '../../../src/firestore/index.js';

afterEach(() => cleanup());

// Shared sandbox + Firestore handle. The hook calls `doc()` to
// parse text input and `query()` to fetch a collection's first
// page — both refuse refs that didn't come from a pyric/firestore
// factory. Initialize once + reuse so the multi-init upstream bug
// (M1 note) doesn't apply.
const sandbox = initializeSandbox();
const firestore = getFirestore(sandbox.withAuth({ uid: 'tester' }));

function realColl(id: string): CollectionReference {
  return collFn(firestore, id);
}

function q(container: HTMLElement, sel: string): HTMLElement {
  const el = container.querySelector(sel);
  if (!el) throw new Error(`No element matching ${sel}`);
  return el as HTMLElement;
}

describe('<ReferencePicker>', () => {
  it('renders a path input with the initial value', async () => {
    const { container } = render(
      <ReferencePicker
        firestore={firestore}
        listCollections={async () => []}
        initialPath="users/alice"
      />,
    );
    const input = q(container, '[data-pyric-reference-path-input]') as HTMLInputElement;
    expect(input.value).toBe('users/alice');
  });

  it('Commit button is disabled when path is invalid', async () => {
    const { container } = render(
      <ReferencePicker
        firestore={firestore}
        listCollections={async () => []}
        initialPath="users"
      />,
    );
    const commit = q(container, '[data-pyric-reference-commit]') as HTMLButtonElement;
    expect(commit.disabled).toBe(true);
  });

  it('Commit button is enabled for a valid path and fires onPick', async () => {
    let picked: DocumentReference | null = null;
    const { container } = render(
      <ReferencePicker
        firestore={firestore}
        listCollections={async () => []}
        initialPath="users/alice"
        onPick={(r) => {
          picked = r;
        }}
      />,
    );
    const commit = q(container, '[data-pyric-reference-commit]') as HTMLButtonElement;
    expect(commit.disabled).toBe(false);
    act(() => {
      fireEvent.click(commit);
    });
    expect(picked?.path).toBe('users/alice');
  });

  it('toggling browse opens the panel and shows root collections', async () => {
    const { container } = render(
      <ReferencePicker
        firestore={firestore}
        listCollections={async () => [realColl('users'), realColl('posts')]}
      />,
    );
    expect(container.querySelector('[data-pyric-ui="reference-browse-panel"]')).toBeNull();
    const toggle = q(container, '[data-pyric-reference-browse-toggle]');
    act(() => {
      fireEvent.click(toggle);
    });
    expect(container.querySelector('[data-pyric-ui="reference-browse-panel"]')).not.toBeNull();
    await waitFor(() => {
      const items = container.querySelectorAll(
        '[data-pyric-browse-entry][data-pyric-entry-kind="collection"]',
      );
      expect(items.length).toBe(2);
    });
  });

  it('drilling into a collection swaps the panel to a document list', async () => {
    const { container } = render(
      <ReferencePicker
        firestore={firestore}
        listCollections={async () => [realColl('users')]}
      />,
    );
    act(() => {
      fireEvent.click(q(container, '[data-pyric-reference-browse-toggle]'));
    });
    await waitFor(() => {
      expect(
        container.querySelectorAll(
          '[data-pyric-browse-entry][data-pyric-entry-kind="collection"]',
        ).length,
      ).toBe(1);
    });
    // Click the `users` collection. The hook will trigger a getDocs
    // call; the docs come back empty from our mock because we don't
    // stub getDocs. That's fine — we're verifying the panel switches
    // to the document-list pane.
    act(() => {
      fireEvent.click(q(container, '[data-pyric-browse-select]'));
    });
    await waitFor(() => {
      expect(container.querySelector('[data-pyric-browse-documents]')).not.toBeNull();
    });
  });

  it('back button is disabled at root', () => {
    const { container } = render(
      <ReferencePicker
        firestore={firestore}
        listCollections={async () => [realColl('users')]}
      />,
    );
    act(() => {
      fireEvent.click(q(container, '[data-pyric-reference-browse-toggle]'));
    });
    const back = q(container, '[data-pyric-browse-back]') as HTMLButtonElement;
    expect(back.disabled).toBe(true);
  });
});

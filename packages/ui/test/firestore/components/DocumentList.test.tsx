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

import { afterEach, describe, it, expect } from 'bun:test';
import { render, cleanup, fireEvent, act } from '@testing-library/react';
import { DocumentList } from '../../../src/firestore/index.js';
import type { DocumentReference, QueryDocumentSnapshot } from 'pyric/firestore';

afterEach(() => cleanup());

function fakeSnap(id: string, data: Record<string, unknown>): QueryDocumentSnapshot {
  const ref = {
    path: `things/${id}`,
    id,
    firestore: {},
    type: 'document',
  } as unknown as DocumentReference;
  return {
    id,
    ref,
    exists: true,
    data: () => data,
  } as unknown as QueryDocumentSnapshot;
}

function queryAll(c: HTMLElement, sel: string): HTMLElement[] {
  return Array.from(c.querySelectorAll(sel)) as HTMLElement[];
}

describe('<DocumentList>', () => {
  it('renders one row per document', () => {
    const docs = [fakeSnap('a', { v: 1 }), fakeSnap('b', { v: 2 })];
    const { container } = render(<DocumentList documents={docs} />);
    const rows = queryAll(container, '[data-pyric-document-entry]');
    expect(rows.length).toBe(2);
    expect(rows.map((r) => r.dataset.pyricDocumentId)).toEqual(['a', 'b']);
  });

  it('renders empty state when no documents', () => {
    const { container } = render(
      <DocumentList documents={[]} emptyState={<p>nothing</p>} />,
    );
    const root = container.querySelector('[data-pyric-ui="document-list"]') as HTMLElement;
    expect(root.hasAttribute('data-pyric-empty')).toBe(true);
    expect(root.textContent).toBe('nothing');
  });

  it('renders Load More button when hasMore + onLoadMore', () => {
    const docs = [fakeSnap('a', {})];
    let called = false;
    const { container } = render(
      <DocumentList
        documents={docs}
        hasMore
        onLoadMore={() => {
          called = true;
        }}
      />,
    );
    const btn = container.querySelector('[data-pyric-load-more]') as HTMLButtonElement;
    expect(btn).not.toBeNull();
    act(() => {
      fireEvent.click(btn);
    });
    expect(called).toBe(true);
  });

  it('does NOT render Load More when hasMore is false', () => {
    const { container } = render(
      <DocumentList documents={[fakeSnap('a', {})]} hasMore={false} onLoadMore={() => undefined} />,
    );
    expect(container.querySelector('[data-pyric-load-more]')).toBeNull();
  });

  it('uses renderLabel override when supplied', () => {
    const docs = [fakeSnap('a', { name: 'Alice' })];
    const { container } = render(
      <DocumentList
        documents={docs}
        renderLabel={(doc) => <em>{doc.data().name as string}</em>}
      />,
    );
    const btn = container.querySelector('[data-pyric-document-select]') as HTMLElement;
    expect(btn.textContent).toBe('Alice');
  });

  it('fires onSelect with the DocumentReference', () => {
    const docs = [fakeSnap('first', {}), fakeSnap('second', {})];
    let picked: DocumentReference | null = null;
    const { container } = render(
      <DocumentList
        documents={docs}
        onSelect={(ref) => {
          picked = ref;
        }}
      />,
    );
    const btns = queryAll(container, '[data-pyric-document-select]');
    act(() => {
      fireEvent.click(btns[1]);
    });
    expect(picked?.id).toBe('second');
  });

  it('switches to virtualized rendering above the threshold', () => {
    const docs = Array.from({ length: 25 }, (_, i) =>
      fakeSnap(`doc-${i}`, { i }),
    );
    const { container } = render(
      <DocumentList documents={docs} virtualizeThreshold={10} />,
    );
    const root = container.querySelector('[data-pyric-ui="document-list"]') as HTMLElement;
    expect(root.hasAttribute('data-pyric-virtualized')).toBe(true);
    // The plain <ul> renderer is replaced by the VirtualList shell.
    expect(container.querySelector('[data-pyric-document-list-items]')).toBeNull();
    expect(container.querySelector('[data-pyric-ui="virtual-list"]')).not.toBeNull();
  });

  it('keeps the plain renderer below the threshold', () => {
    const docs = Array.from({ length: 5 }, (_, i) => fakeSnap(`doc-${i}`, { i }));
    const { container } = render(
      <DocumentList documents={docs} virtualizeThreshold={10} />,
    );
    const root = container.querySelector('[data-pyric-ui="document-list"]') as HTMLElement;
    expect(root.hasAttribute('data-pyric-virtualized')).toBe(false);
    expect(container.querySelector('[data-pyric-document-list-items]')).not.toBeNull();
    expect(container.querySelector('[data-pyric-ui="virtual-list"]')).toBeNull();
  });

  it('renders error state with message', () => {
    const { container } = render(
      <DocumentList documents={[]} error={new Error('denied')} />,
    );
    const root = container.querySelector('[data-pyric-ui="document-list"]') as HTMLElement;
    expect(root.hasAttribute('data-pyric-error')).toBe(true);
    expect(root.textContent).toContain('denied');
  });
});

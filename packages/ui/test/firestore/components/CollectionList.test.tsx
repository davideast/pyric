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
import { render, cleanup, fireEvent, act } from '@testing-library/react';
import { CollectionList } from '../../../src/firestore/index.js';
import type { CollectionReference } from 'pyric/firestore';

afterEach(() => cleanup());

function fakeColl(id: string, path?: string): CollectionReference {
  return {
    id,
    path: path ?? id,
    firestore: {} as any,
    type: 'collection',
  } as unknown as CollectionReference;
}

function queryAll(container: HTMLElement, sel: string): HTMLElement[] {
  return Array.from(container.querySelectorAll(sel)) as HTMLElement[];
}

describe('<CollectionList>', () => {
  it('renders one row per collection', () => {
    const colls = [fakeColl('users'), fakeColl('posts'), fakeColl('logs')];
    const { container } = render(<CollectionList collections={colls} />);
    const rows = queryAll(container, '[data-pyric-collection-entry]');
    expect(rows.length).toBe(3);
    expect(rows.map((r) => r.dataset.pyricCollectionId)).toEqual([
      'users',
      'posts',
      'logs',
    ]);
  });

  it('renders empty state when no collections', () => {
    const { container } = render(
      <CollectionList collections={[]} emptyState={<p>no collections</p>} />,
    );
    const root = container.querySelector('[data-pyric-ui="collection-list"]') as HTMLElement;
    expect(root.hasAttribute('data-pyric-empty')).toBe(true);
    expect(root.textContent).toBe('no collections');
  });

  it('renders loading state', () => {
    const { container } = render(<CollectionList collections={[]} isLoading />);
    const root = container.querySelector('[data-pyric-ui="collection-list"]') as HTMLElement;
    expect(root.hasAttribute('data-pyric-loading')).toBe(true);
  });

  it('renders error state with the message', () => {
    const { container } = render(
      <CollectionList collections={[]} error={new Error('denied')} />,
    );
    const root = container.querySelector('[data-pyric-ui="collection-list"]') as HTMLElement;
    expect(root.hasAttribute('data-pyric-error')).toBe(true);
    expect(root.textContent).toContain('denied');
  });

  it('fires onSelect with the clicked collection', () => {
    const colls = [fakeColl('users'), fakeColl('posts')];
    let picked: CollectionReference | null = null;
    const { container } = render(
      <CollectionList
        collections={colls}
        onSelect={(coll) => {
          picked = coll;
        }}
      />,
    );
    const buttons = queryAll(container, '[data-pyric-collection-select]');
    act(() => {
      fireEvent.click(buttons[1]);
    });
    expect(picked?.id).toBe('posts');
  });
});

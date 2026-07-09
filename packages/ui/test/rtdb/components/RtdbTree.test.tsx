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
// React's change-event plugin probes IE-era attachEvent when it focuses a
// text input under JSDOM — no-op stubs keep the console clean.
(dom.window.HTMLElement.prototype as any).attachEvent = () => {};
(dom.window.HTMLElement.prototype as any).detachEvent = () => {};
g.IS_REACT_ACT_ENVIRONMENT = true;

import { afterEach, describe, it, expect } from 'bun:test';
import { render, cleanup, fireEvent, act } from '@testing-library/react';
import { useState } from 'react';
import {
  RtdbPathBar,
  RtdbTree,
  useRtdbTree,
  rtdbPathSegments,
  rtdbValueAt,
  type RtdbApi,
} from '../../../src/rtdb/index.js';

afterEach(() => cleanup());

// ── Fake backend: an in-memory tree with realtime value subscriptions ──────

function setAt(root: unknown, path: string, value: unknown): unknown {
  const segments = rtdbPathSegments(path);
  if (segments.length === 0) return value;
  const clone: Record<string, unknown> =
    root !== null && typeof root === 'object' && !Array.isArray(root)
      ? { ...(root as Record<string, unknown>) }
      : {};
  const [head, ...rest] = segments;
  const child = setAt(clone[head] ?? null, `/${rest.join('/')}`, value);
  if (child === null) {
    delete clone[head];
  } else {
    clone[head] = child;
  }
  return Object.keys(clone).length === 0 ? null : clone;
}

function makeFakeApi(initial: unknown) {
  let root: unknown = initial;
  const subs = new Set<{ path: string; next: (v: unknown) => void }>();
  const emit = () => {
    for (const sub of subs) sub.next(rtdbValueAt(root, sub.path));
  };
  const api: RtdbApi = {
    set: (path, value) => {
      root = setAt(root, path, value);
      emit();
      return Promise.resolve();
    },
    remove: (path) => {
      root = setAt(root, path, null);
      emit();
      return Promise.resolve();
    },
    subscribeValue: (path, next) => {
      const sub = { path, next };
      subs.add(sub);
      next(rtdbValueAt(root, path));
      return () => subs.delete(sub);
    },
  };
  return { api, current: () => root };
}

// ── Harness: path bar + tree wired the way Studio wires them ───────────────

function Viewer({ api, pageSize }: { api: RtdbApi; pageSize?: number }) {
  const [path, setPath] = useState('/');
  const tree = useRtdbTree(api, path, { pageSize });
  return (
    <>
      <RtdbPathBar path={path} onNavigate={setPath} rootLabel="test-sandbox" />
      <RtdbTree tree={tree} api={api} onNavigate={setPath} rootLabel="test-sandbox" />
    </>
  );
}

function keys(c: HTMLElement): string[] {
  return Array.from(c.querySelectorAll('[data-rtdb-key]')).map((el) => el.textContent ?? '');
}

const flush = () => act(async () => {});

describe('RtdbTree: rendering + lazy expansion', () => {
  const seed = {
    rooms: { r1: { title: 'Alpha', open: true }, r2: { title: 'Beta' } },
    version: 2,
  };

  it('renders the view root expanded with collapsed parents and leaf rows', () => {
    const { api } = makeFakeApi(seed);
    const { container } = render(<Viewer api={api} />);
    // Root level: rooms (parent, collapsed) + version (leaf) + the root row.
    expect(keys(container)).toEqual(['test-sandbox', 'rooms', 'version']);
    const leaf = container.querySelector('[data-rtdb-kind="leaf"] [data-rtdb-value]')!;
    expect(leaf.textContent).toBe('2');
    expect(leaf.getAttribute('data-rtdb-type')).toBe('number');
    // Collapsed: nothing under /rooms is mounted (lazy rendering).
    expect(container.textContent).not.toContain('Alpha');
  });

  it('caret expands and collapses a level at a time', () => {
    const { api } = makeFakeApi(seed);
    const { container } = render(<Viewer api={api} />);
    const caret = container.querySelector('[data-rtdb-caret]')!; // /rooms
    fireEvent.click(caret);
    expect(keys(container)).toEqual(['test-sandbox', 'rooms', 'r1', 'r2', 'version']);
    // Grandchildren are still collapsed.
    expect(container.textContent).not.toContain('Alpha');
    fireEvent.click(caret);
    expect(keys(container)).toEqual(['test-sandbox', 'rooms', 'version']);
  });

  it('key click re-roots the view (navigation)', () => {
    const { api } = makeFakeApi(seed);
    const { container } = render(<Viewer api={api} />);
    const roomsKey = Array.from(container.querySelectorAll('[data-rtdb-key]')).find(
      (el) => el.textContent === 'rooms',
    )!;
    fireEvent.click(roomsKey);
    // The path bar now shows /rooms and the tree's view root is rooms.
    const crumbs = Array.from(container.querySelectorAll('[data-rtdb-crumb]'));
    expect(crumbs.map((c) => c.textContent)).toEqual(['test-sandbox', 'rooms']);
    expect(keys(container)).toEqual(['rooms', 'r1', 'r2']);
  });

  it('live updates flow into the visible subtree', async () => {
    const { api } = makeFakeApi(seed);
    const { container } = render(<Viewer api={api} />);
    await act(async () => {
      await api.set('/version', 3);
    });
    expect(container.querySelector('[data-rtdb-kind="leaf"] [data-rtdb-value]')!.textContent).toBe(
      '3',
    );
  });

  it('shows the empty state when the root has no data', () => {
    const { api } = makeFakeApi(null);
    const { container } = render(<Viewer api={api} />);
    expect(container.querySelector('[data-rtdb-empty]')).not.toBeNull();
  });
});

describe('RtdbTree: inline mutations', () => {
  it('leaf click-to-edit saves through the api', async () => {
    const { api, current } = makeFakeApi({ version: 2 });
    const { container } = render(<Viewer api={api} />);
    fireEvent.click(container.querySelector('[data-rtdb-value]')!);
    const editor = container.querySelector('[data-rtdb-editor]')!;
    const valueInput = editor.querySelector('[data-rtdb-editor-value]') as HTMLInputElement;
    expect(valueInput.value).toBe('2');
    fireEvent.change(valueInput, { target: { value: '42' } });
    fireEvent.submit(editor);
    await flush();
    expect(current()).toEqual({ version: 42 });
    expect(container.querySelector('[data-rtdb-editor]')).toBeNull();
  });

  it('edit validates by type and shows an inline error', async () => {
    const { api, current } = makeFakeApi({ version: 2 });
    const { container } = render(<Viewer api={api} />);
    fireEvent.click(container.querySelector('[data-rtdb-value]')!);
    const editor = container.querySelector('[data-rtdb-editor]')!;
    fireEvent.change(editor.querySelector('[data-rtdb-editor-value]')!, {
      target: { value: 'not-a-number' },
    });
    fireEvent.submit(editor);
    await flush();
    expect(container.querySelector('[data-rtdb-editor-error]')!.textContent).toContain(
      'not a number',
    );
    expect(current()).toEqual({ version: 2 });
  });

  it('add child: + opens a key/value row and writes the typed value', async () => {
    const { api, current } = makeFakeApi({ rooms: { r1: { title: 'Alpha' } } });
    const { container } = render(<Viewer api={api} />);
    // Add to the view root.
    const rootAdd = container.querySelector(
      '[data-rtdb-view-root] > [data-rtdb-row] [data-rtdb-action-add]',
    )!;
    fireEvent.click(rootAdd);
    const editor = container.querySelector('[data-rtdb-editor]')!;
    fireEvent.change(editor.querySelector('[data-rtdb-editor-key]')!, {
      target: { value: 'flag' },
    });
    fireEvent.change(editor.querySelector('[data-rtdb-editor-type]')!, {
      target: { value: 'boolean' },
    });
    fireEvent.submit(editor);
    await flush();
    expect(rtdbValueAt(current(), '/flag')).toBe(false);
    // Realtime: the new leaf appears without a manual refresh.
    expect(keys(container)).toContain('flag');
  });

  it('add child rejects invalid keys inline', async () => {
    const { api, current } = makeFakeApi({ a: 1 });
    const { container } = render(<Viewer api={api} />);
    fireEvent.click(
      container.querySelector('[data-rtdb-view-root] > [data-rtdb-row] [data-rtdb-action-add]')!,
    );
    const editor = container.querySelector('[data-rtdb-editor]')!;
    fireEvent.change(editor.querySelector('[data-rtdb-editor-key]')!, {
      target: { value: 'bad/key' },
    });
    fireEvent.submit(editor);
    await flush();
    expect(container.querySelector('[data-rtdb-editor-error]')!.textContent).toContain(`"/"`);
    expect(current()).toEqual({ a: 1 });
  });

  it('delete is a two-step inline confirm; cancel aborts', async () => {
    const { api, current } = makeFakeApi({ version: 2, keep: 'yes' });
    const { container } = render(<Viewer api={api} />);
    const leafDelete = () =>
      Array.from(container.querySelectorAll('[data-rtdb-kind="leaf"]'))
        .find((n) => n.textContent?.includes('version'))!
        .querySelector('[data-rtdb-action-delete]')!;
    fireEvent.click(leafDelete());
    // Nothing deleted yet — an inline confirm appeared (no modal).
    expect(current()).toEqual({ version: 2, keep: 'yes' });
    const confirm = container.querySelector('[data-rtdb-confirm]')!;
    fireEvent.click(confirm.querySelector('[data-rtdb-confirm-no]')!);
    expect(container.querySelector('[data-rtdb-confirm]')).toBeNull();
    expect(current()).toEqual({ version: 2, keep: 'yes' });

    fireEvent.click(leafDelete());
    await act(async () => {
      fireEvent.click(container.querySelector('[data-rtdb-confirm-yes]')!);
    });
    expect(current()).toEqual({ keep: 'yes' });
    expect(keys(container)).not.toContain('version');
  });
});

describe('RtdbTree: paging (console-style show more)', () => {
  it('caps a wide level at the page size and reveals more on demand', () => {
    const wide = Object.fromEntries(
      Array.from({ length: 5 }, (_, i) => [`k${i}`, i]),
    );
    const { api } = makeFakeApi({ wide });
    const { container } = render(<Viewer api={api} pageSize={2} />);
    fireEvent.click(container.querySelector('[data-rtdb-caret]')!); // expand /wide
    expect(keys(container)).toEqual(['test-sandbox', 'wide', 'k0', 'k1']);
    const showMore = container.querySelector('[data-rtdb-show-more]')!;
    expect(showMore.textContent).toContain('3 hidden');
    fireEvent.click(showMore);
    expect(keys(container)).toEqual(['test-sandbox', 'wide', 'k0', 'k1', 'k2', 'k3']);
    fireEvent.click(container.querySelector('[data-rtdb-show-more]')!);
    expect(keys(container)).toEqual(['test-sandbox', 'wide', 'k0', 'k1', 'k2', 'k3', 'k4']);
    expect(container.querySelector('[data-rtdb-show-more]')).toBeNull();
  });
});

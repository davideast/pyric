// Install JSDOM globals before importing React or RTL.
import { JSDOM } from 'jsdom';
const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>', {
  pretendToBeVisual: true,
  url: 'http://localhost/rtdb',
});
const g = globalThis as any;
g.window = dom.window;
g.document = dom.window.document;
g.HTMLElement = dom.window.HTMLElement;
g.Element = dom.window.Element;
g.Node = dom.window.Node;
g.Event = dom.window.Event;
g.getComputedStyle = dom.window.getComputedStyle.bind(dom.window);
g.IS_REACT_ACT_ENVIRONMENT = true;

import { afterEach, describe, expect, it } from 'bun:test';
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { normalizeRtdbPath, type RtdbApi } from '@pyric/ui/rtdb';
import { RoutedRtdbViewer } from '../../../src/features/rtdb/RtdbSurface.js';
import { documentHref } from '../../../src/features/listeners/listener-links.js';

afterEach(() => cleanup());

/**
 * An in-memory RTDB backend in the shape the viewer consumes: one value
 * subscription per view root, delivered synchronously from a plain object so a
 * test asserts on the rendered tree without a worker.
 */
function fakeRtdb(data: Record<string, unknown>): RtdbApi {
  const valueAt = (path: string): unknown => {
    let node: unknown = data;
    for (const seg of normalizeRtdbPath(path).split('/').filter(Boolean)) {
      if (node === null || typeof node !== 'object') return null;
      node = (node as Record<string, unknown>)[seg] ?? null;
    }
    return node;
  };
  return {
    set: async () => {},
    remove: async () => {},
    subscribeValue: (path, next) => {
      next(valueAt(path));
      return () => {};
    },
  };
}

const ROOMS = {
  rooms: {
    lobby: { alice: { status: 'here' }, bob: { status: 'away' } },
  },
};

function renderAt(path: string, data: Record<string, unknown> = ROOMS) {
  window.history.replaceState(null, '', path);
  return render(<RoutedRtdbViewer api={fakeRtdb(data)} instanceLabel="demo-sandbox" />);
}

/** The tree's view-root row label — the node the viewer is focused on. */
function focusedKey(container: HTMLElement): string | undefined {
  return (
    container
      .querySelector('[data-rtdb-view-root] [data-rtdb-key]')
      ?.textContent ?? undefined
  );
}

function crumbTrail(container: HTMLElement): string[] {
  return [...container.querySelectorAll('[data-rtdb-crumb]')].map(
    (el) => el.textContent ?? '',
  );
}

describe('the routed path the RTDB viewer focuses', () => {
  it('focuses and expands the path the route names', async () => {
    const view = renderAt('/rtdb/rooms/lobby/alice');

    await waitFor(() => expect(focusedKey(view.container)).toBe('alice'));
    expect(crumbTrail(view.container)).toEqual([
      'demo-sandbox',
      'rooms',
      'lobby',
      'alice',
    ]);
    // The focused node's own children render, so the subtree is expanded.
    expect(view.container.textContent).toContain('status');
    expect(view.container.querySelector('[data-rtdb-missing]')).toBeNull();
  });

  it('selects the root for /rtdb with no path', async () => {
    const view = renderAt('/rtdb');

    await waitFor(() => expect(focusedKey(view.container)).toBe('demo-sandbox'));
    expect(window.location.pathname).toBe('/rtdb');
    expect(view.container.querySelector('[data-rtdb-missing]')).toBeNull();
  });

  it('writes the route when a node is clicked in the tree', async () => {
    const view = renderAt('/rtdb/rooms');

    await waitFor(() => expect(focusedKey(view.container)).toBe('rooms'));
    const lobby = [...view.container.querySelectorAll('[data-rtdb-key]')].find(
      (el) => el.textContent === 'lobby',
    )!;
    fireEvent.click(lobby);

    expect(window.location.pathname).toBe('/rtdb/rooms/lobby');
    await waitFor(() => expect(focusedKey(view.container)).toBe('lobby'));
  });

  it('follows the route back to a shallower path', async () => {
    const view = renderAt('/rtdb/rooms/lobby/alice');
    await waitFor(() => expect(focusedKey(view.container)).toBe('alice'));

    act(() => {
      window.history.replaceState(null, '', '/rtdb/rooms');
      window.dispatchEvent(new dom.window.PopStateEvent('popstate'));
    });

    await waitFor(() => expect(focusedKey(view.container)).toBe('rooms'));
  });

  it('falls back to the nearest existing ancestor and names the missing tail', async () => {
    const view = renderAt('/rtdb/rooms/lobby/carol/status');

    await waitFor(() =>
      expect(view.container.querySelector('[data-rtdb-missing]')).not.toBeNull(),
    );
    expect(focusedKey(view.container)).toBe('lobby');
    const note = view.container.querySelector('[data-rtdb-missing]')!.textContent!;
    expect(note).toContain('This path does not exist.');
    expect(note).toContain('/rooms/lobby');
    expect(note).toContain('/carol/status');
    // The URL still names what was asked for.
    expect(window.location.pathname).toBe('/rtdb/rooms/lobby/carol/status');
  });

  it('opens the href the Listeners feature builds for a delivered path', async () => {
    const href = documentHref('database', 'rooms/lobby/alice');
    expect(href).toBe('/rtdb/rooms/lobby/alice');

    const view = renderAt(href);
    await waitFor(() => expect(focusedKey(view.container)).toBe('alice'));
  });
});

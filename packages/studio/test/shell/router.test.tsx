// Install JSDOM globals before importing React or RTL.
import { JSDOM } from 'jsdom';
const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>', {
  pretendToBeVisual: true,
  url: 'http://localhost:3000/traffic',
});
const g = globalThis as any;
g.window = dom.window;
g.Window = dom.window.Window;
g.document = dom.window.document;
g.navigator = dom.window.navigator;
g.HTMLElement = dom.window.HTMLElement;
g.SVGElement = dom.window.SVGElement;
g.Element = dom.window.Element;
g.Node = dom.window.Node;
g.Event = dom.window.Event;
g.MouseEvent = dom.window.MouseEvent;
g.KeyboardEvent = dom.window.KeyboardEvent;
g.MutationObserver = dom.window.MutationObserver;
g.requestAnimationFrame = dom.window.requestAnimationFrame.bind(dom.window);
g.cancelAnimationFrame = dom.window.cancelAnimationFrame.bind(dom.window);
g.getComputedStyle = dom.window.getComputedStyle.bind(dom.window);
g.IS_REACT_ACT_ENVIRONMENT = true;

import { afterEach, describe, expect, it } from 'bun:test';
import { act, cleanup, renderHook } from '@testing-library/react';
import { resetTrafficSubrouteQuery } from '../../src/features/traffic/traffic-tabs.js';
import { currentPath, replacePath, useRoute } from '../../src/shell/router.js';

afterEach(() => {
  cleanup();
});

describe('useRoute top-level tab navigation (#2540)', () => {
  const VALID = ['home', 'traffic', 'firestore'] as const;

  it('clears stale ?inspect and subview query keys when clicking top-level Traffic while preserving ?hide=studio and ?from=', () => {
    replacePath({
      tab: 'traffic',
      query: { inspect: 'ev-1', view: 'billable', hide: 'studio', from: 'user:u-1' },
    });
    const { result } = renderHook(() => useRoute(VALID, 'home', resetTrafficSubrouteQuery));
    expect(result.current[0]).toBe('traffic');

    act(() => {
      result.current[1]('traffic');
    });

    expect(currentPath().tab).toBe('traffic');
    expect(currentPath().rest).toEqual([]);
    expect(currentPath().query.inspect).toBeUndefined();
    expect(currentPath().query.view).toBeUndefined();
    expect(currentPath().query.hide).toBe('studio');
    expect(currentPath().query.from).toBe('user:u-1');
  });

  it('returns to clean /traffic when clicking top-level Traffic from ?inspect=ev-1 or /traffic/listeners/<id>', () => {
    replacePath({ tab: 'traffic', query: { inspect: 'ev-1' } });
    const { result } = renderHook(() => useRoute(VALID, 'home', resetTrafficSubrouteQuery));

    act(() => {
      result.current[1]('traffic');
    });
    expect(window.location.pathname + window.location.search).toBe('/traffic');

    act(() => {
      replacePath({ tab: 'traffic', rest: ['listeners', 'l-1'], query: { hide: 'studio' } });
    });
    act(() => {
      result.current[1]('traffic');
    });
    expect(window.location.pathname + window.location.search).toBe('/traffic?hide=studio');
  });

  it('leaves the URL unchanged on active-tab re-click when no reselectActiveQuery callback is supplied', () => {
    replacePath({ tab: 'firestore', query: { inspect: 'doc-1' } });
    const { result } = renderHook(() => useRoute(VALID, 'home'));

    act(() => {
      result.current[1]('firestore');
    });
    expect(window.location.pathname + window.location.search).toBe('/firestore?inspect=doc-1');
  });
});

import { JSDOM } from 'jsdom';
import { describe, expect, it } from 'bun:test';
import {
  installReactCommitSource,
  reactRendered,
} from '../../../src/serve/runtime/react-commit-source.js';

interface HookLike {
  renderers?: Map<unknown, unknown>;
  inject?: (renderer: unknown) => number;
  onCommitFiberRoot?: (...args: unknown[]) => void;
}

function hookOn(view: Record<string, unknown>): HookLike {
  return view.__REACT_DEVTOOLS_GLOBAL_HOOK__ as HookLike;
}

describe('installing the commit source', () => {
  it('installs a hook React can inject into', () => {
    const view: Record<string, unknown> = {};
    const source = installReactCommitSource(view);
    const hook = hookOn(view);
    expect(typeof hook.inject).toBe('function');
    expect(source.available()).toBe(false);
    expect(source.reason()).toContain('No React renderer');

    hook.inject!({ version: '19.0.0' });
    expect(source.available()).toBe(true);
    expect(source.reason()).toBeNull();
  });

  it('reports every commit to its subscribers', () => {
    const view: Record<string, unknown> = {};
    const source = installReactCommitSource(view);
    const seen: number[] = [];
    const stop = source.subscribe(() => seen.push(seen.length));

    hookOn(view).onCommitFiberRoot!(1, { current: {} });
    hookOn(view).onCommitFiberRoot!(1, { current: {} });
    expect(seen).toHaveLength(2);

    stop();
    hookOn(view).onCommitFiberRoot!(1, { current: {} });
    expect(seen).toHaveLength(2);
  });

  it('keeps an extension handler that got there first', () => {
    const calls: unknown[][] = [];
    const view: Record<string, unknown> = {
      __REACT_DEVTOOLS_GLOBAL_HOOK__: {
        renderers: new Map([[1, { version: '19.0.0' }]]),
        onCommitFiberRoot: (...args: unknown[]) => calls.push(args),
      },
    };
    const source = installReactCommitSource(view);
    let commits = 0;
    source.subscribe(() => {
      commits += 1;
    });

    hookOn(view).onCommitFiberRoot!(1, { current: {} });
    expect(calls).toHaveLength(1);
    expect(commits).toBe(1);
    expect(source.available()).toBe(true);
  });

  it('gives the extension its handler back when disposed', () => {
    const original = (): void => {};
    const view: Record<string, unknown> = {
      __REACT_DEVTOOLS_GLOBAL_HOOK__: { renderers: new Map(), onCommitFiberRoot: original },
    };
    const source = installReactCommitSource(view);
    expect(hookOn(view).onCommitFiberRoot).not.toBe(original);
    source.dispose();
    expect(hookOn(view).onCommitFiberRoot).toBe(original);
  });

  it('survives a subscriber that throws and still runs the rest', () => {
    const view: Record<string, unknown> = {};
    const source = installReactCommitSource(view);
    let reached = 0;
    source.subscribe(() => {
      throw new Error('subscriber');
    });
    source.subscribe(() => {
      reached += 1;
    });

    expect(() => hookOn(view).onCommitFiberRoot!(1, {})).not.toThrow();
    expect(reached).toBe(1);
  });

  it('reports a target it cannot install on rather than throwing', () => {
    const source = installReactCommitSource(null);
    expect(source.available()).toBe(false);
    expect(source.reason()).toContain('could not be installed');
    expect(() => source.subscribe(() => {})()).not.toThrow();
    expect(() => source.dispose()).not.toThrow();
  });
});

describe('detecting a React that already rendered', () => {
  it('finds the property React puts on its host nodes', () => {
    const dom = new JSDOM('<!doctype html><body><div id="app"></div></body>');
    const element = dom.window.document.querySelector('#app')!;
    expect(reactRendered(dom.window.document)).toBe(false);
    (element as unknown as Record<string, unknown>)['__reactFiber$xyz'] = {};
    expect(reactRendered(dom.window.document)).toBe(true);
  });

  it('answers false without a document', () => {
    expect(reactRendered(null)).toBe(false);
    expect(reactRendered(undefined)).toBe(false);
  });
});

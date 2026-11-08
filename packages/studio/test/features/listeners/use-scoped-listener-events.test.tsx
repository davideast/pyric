import { JSDOM } from 'jsdom';
const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>');
const g = globalThis as Record<string, unknown>;
g.window = dom.window;
g.document = dom.window.document;
g.IS_REACT_ACT_ENVIRONMENT = true;

import type { ReactNode } from 'react';
import { afterEach, describe, expect, it } from 'bun:test';
import { cleanup, renderHook } from '@testing-library/react';
import { EnvironmentProvider } from '../../../src/shell/environment.js';
import { useScopedListenerEvents } from '../../../src/features/listeners/use-scoped-listener-events.js';

afterEach(() => cleanup());

function wrapper({ children }: { children: ReactNode }) {
  return <EnvironmentProvider mode="local">{children}</EnvironmentProvider>;
}

describe('useScopedListenerEvents', () => {
  it('returns an empty list before any Studio worker environment attaches, with or without a fromScope', () => {
    const unscoped = renderHook(() => useScopedListenerEvents(), { wrapper });
    expect(unscoped.result.current).toEqual([]);

    const scoped = renderHook(() => useScopedListenerEvents('client:page:tab-1'), { wrapper });
    expect(scoped.result.current).toEqual([]);
  });
});

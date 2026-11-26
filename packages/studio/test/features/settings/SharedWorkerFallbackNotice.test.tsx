// Install JSDOM globals before importing React or RTL.
import { JSDOM } from 'jsdom';
const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>', {
  pretendToBeVisual: true,
});
const g = globalThis as Record<string, unknown>;
g.window = dom.window;
g.document = dom.window.document;
g.HTMLElement = dom.window.HTMLElement;
g.Element = dom.window.Element;
g.Node = dom.window.Node;
g.IS_REACT_ACT_ENVIRONMENT = true;

import { afterEach, describe, expect, it } from 'bun:test';
import { cleanup, render } from '@testing-library/react';
import { SharedWorkerFallbackNotice } from '../../../src/features/settings/SharedWorkerFallbackNotice.js';

const hadSharedWorker = 'SharedWorker' in g;
const prevSharedWorker = g.SharedWorker;
const hadBroadcastChannel = 'BroadcastChannel' in g;
const prevBroadcastChannel = g.BroadcastChannel;

afterEach(() => {
  cleanup();
  if (hadSharedWorker) {
    g.SharedWorker = prevSharedWorker;
  } else {
    Reflect.deleteProperty(g, 'SharedWorker');
  }
  if (hadBroadcastChannel) {
    g.BroadcastChannel = prevBroadcastChannel;
  } else {
    Reflect.deleteProperty(g, 'BroadcastChannel');
  }
});

describe('SharedWorkerFallbackNotice', () => {
  it('renders nothing when the worker plane is healthy or hosted', () => {
    const { container } = render(<SharedWorkerFallbackNotice workerDown={false} />);
    expect(container.querySelector('[data-shared-worker-fallback]')).toBeNull();
    expect(container.childElementCount).toBe(0);
  });

  it('explains older-Safari / no-SharedWorker degradation with BroadcastChannel sync when SharedWorker is missing', () => {
    Reflect.deleteProperty(g, 'SharedWorker');
    g.BroadcastChannel = class {};

    const { container } = render(<SharedWorkerFallbackNotice workerDown={true} />);
    const notice = container.querySelector('[data-shared-worker-fallback="unsupported"]');
    expect(notice).not.toBeNull();
    expect(notice?.getAttribute('role')).toBe('status');
    expect(notice?.textContent).toContain('No SharedWorker');
    expect(notice?.textContent).toContain('Safari < 16.4');
    expect(notice?.textContent).toContain('BroadcastChannel cross-tab sync');
    expect(notice?.textContent).toContain('pyric sandbox --hosted');
    expect(notice?.textContent).toContain('pyric({ hosted: true })');
  });

  it('notes isolated per-tab sandboxes when both SharedWorker and BroadcastChannel are missing', () => {
    Reflect.deleteProperty(g, 'SharedWorker');
    Reflect.deleteProperty(g, 'BroadcastChannel');

    const { container } = render(<SharedWorkerFallbackNotice workerDown={true} />);
    const notice = container.querySelector('[data-shared-worker-fallback="unsupported"]');
    expect(notice).not.toBeNull();
    expect(notice?.textContent).toContain('BroadcastChannel is also unavailable');
  });

  it('renders a worker-unreachable diagnostic when SharedWorker exists in globalThis', () => {
    g.SharedWorker = class {};

    const { container } = render(<SharedWorkerFallbackNotice workerDown={true} />);
    const notice = container.querySelector('[data-shared-worker-fallback="unreachable"]');
    expect(notice).not.toBeNull();
    expect(notice?.textContent).toContain('Worker unreachable');
    expect(notice?.textContent).toContain('pyric sandbox --hosted');
  });
});

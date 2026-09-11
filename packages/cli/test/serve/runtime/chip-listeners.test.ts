import { JSDOM } from 'jsdom';
import { describe, expect, it } from 'bun:test';
import { mountPyricRuntimeChip } from '../../../src/serve/runtime/chip.js';
import { createPyricRuntimeStatus } from '../../../src/serve/runtime/status.js';
import type { PyricRuntimeManifest } from '../../../src/serve/runtime/manifest.js';
import type { SandboxEvent } from 'pyric/sandbox';
import { createListenerMode } from '../../../src/serve/runtime/listener-mode.js';

const manifest: PyricRuntimeManifest = {
  studioUrl: '/__pyric/ui/studio',
  worker: { url: '/__pyric/sdk/worker.js', name: 'pyric-shared-worker', servedEpoch: 'bbbbbbbbbbbbbbbb' },
};

type Target = { kind: 'doc'; path: string } | { kind: 'query'; collection: string };

function attach(id: string, listenerId: string, target: Target, owners: unknown[]): SandboxEvent {
  return {
    kind: 'listener_attach',
    id,
    at: 1,
    listenerId,
    target,
    auth: { uid: null, token: null },
    owners,
  } as unknown as SandboxEvent;
}

function setup(options: { attributionEnabled?: boolean } = {}) {
  const dom = new JSDOM(
    '<!doctype html><body><div id="todos"></div><div id="profile"></div></body>',
    { url: 'http://localhost/' },
  );
  const doc = dom.window.document;
  let deliver: ((events: readonly SandboxEvent[]) => void) | null = null;
  const chip = mountPyricRuntimeChip({
    runtime: createPyricRuntimeStatus(manifest),
    document: doc,
    initiallyOpen: true,
    identity: { subscribeAuth: () => () => {} },
    getLens: () => undefined,
    setLens: () => {},
    subscribeLens: () => () => {},
    listeners: (onChange) => createListenerMode({
      document: doc,
      onChange,
      attributionEnabled: () => options.attributionEnabled ?? true,
      incidents: () => [],
      subscribeEvents: (callback) => {
        deliver = callback;
        return () => {
          deliver = null;
        };
      },
    }),
  });
  return {
    doc,
    chip,
    root: chip.element.shadowRoot!,
    push: (events: readonly SandboxEvent[]) => deliver?.(events),
  };
}

function toggle(root: ShadowRoot): void {
  root.querySelector<HTMLButtonElement>('[data-toggle-listeners]')!.click();
}

describe('the chip Listeners mode', () => {
  it('draws outlines when toggled on and clears them when toggled off', () => {
    const page = setup();
    toggle(page.root);
    page.push([attach('e1', 'l1', { kind: 'query', collection: 'todos' }, [{ kind: 'tag', name: 'TodoList', element: '#todos' }])]);
    expect(page.doc.querySelectorAll('[data-pyric-listener-box]')).toHaveLength(1);

    toggle(page.root);
    expect(page.doc.querySelector('[data-pyric-listener-overlay]')).toBeNull();
    page.chip.dispose();
  });

  it('lists a listener nothing on the page could be outlined for', () => {
    const page = setup();
    toggle(page.root);
    page.push([attach('e1', 'l1', { kind: 'doc', path: 'users/u1' }, [{ kind: 'frame', file: '/src/a.ts', line: 2, function: 'useProfile' }])]);

    const panel = page.root.querySelector('[data-listener-panel]');
    expect(panel?.textContent).toContain('useProfile');
    expect(panel?.textContent).toContain('users/u1');
    expect(panel?.textContent).toContain('Nothing on the page could be outlined');
    page.chip.dispose();
  });

  it('draws nothing while listener attribution is off', () => {
    const page = setup({ attributionEnabled: false });
    toggle(page.root);
    page.push([attach('e1', 'l1', { kind: 'query', collection: 'todos' }, [{ kind: 'tag', name: 'TodoList', element: '#todos' }])]);

    expect(page.doc.querySelector('[data-pyric-listener-overlay]')).toBeNull();
    expect(page.root.querySelector('[data-toggle-listeners]')?.getAttribute('aria-pressed')).toBe('false');
    expect(page.root.querySelector('[data-listener-notice]')?.textContent).toContain('attribution is off');
    page.chip.dispose();
  });

  it('removes the overlay on dispose', () => {
    const page = setup();
    toggle(page.root);
    page.push([attach('e1', 'l1', { kind: 'query', collection: 'todos' }, [{ kind: 'tag', name: 'TodoList', element: '#todos' }])]);
    page.chip.dispose();
    expect(page.doc.querySelector('[data-pyric-listener-overlay]')).toBeNull();
  });
});

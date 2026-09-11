import { JSDOM } from 'jsdom';
import { describe, expect, it } from 'bun:test';
import { mountPyricRuntimeChip } from '../../../src/serve/runtime/chip.js';
import { createPyricRuntimeStatus } from '../../../src/serve/runtime/status.js';
import type { PyricRuntimeManifest } from '../../../src/serve/runtime/manifest.js';
import type { SandboxEvent } from 'pyric/sandbox';
import type { ActivityIncident } from 'pyric/firestore/internal';
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

function delivery(id: string, listenerId: string, target: Target): SandboxEvent {
  return {
    kind: 'snapshot_delivery',
    id,
    at: 2,
    listenerId,
    target,
    auth: { uid: null, token: null },
  } as unknown as SandboxEvent;
}

function setup(options: {
  attributionEnabled?: boolean;
  studioUrl?: string | null;
  incidents?: (events: readonly SandboxEvent[]) => readonly ActivityIncident[];
} = {}) {
  const copied: string[] = [];
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
    clipboard: {
      writeText: (text: string) => {
        copied.push(text);
        return Promise.resolve();
      },
    },
    ...('studioUrl' in options ? { studioUrl: options.studioUrl } : {}),
    identity: { subscribeAuth: () => () => {} },
    getLens: () => undefined,
    setLens: () => {},
    subscribeLens: () => () => {},
    listeners: (onChange) => createListenerMode({
      document: doc,
      onChange,
      attributionEnabled: () => options.attributionEnabled ?? true,
      incidents: options.incidents ?? (() => []),
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
    copied,
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

  it('falls back to the target when the only label is a frame function name', () => {
    const page = setup();
    toggle(page.root);
    page.push([attach('e1', 'l1', { kind: 'doc', path: 'users/u1' }, [{ kind: 'frame', file: '/src/a.ts', line: 2, function: 'useProfile' }])]);

    const panel = page.root.querySelector('[data-listener-panel]');
    expect(panel?.textContent).not.toContain('useProfile');
    expect(panel?.textContent).not.toContain('l1');
    expect(panel?.textContent).toContain('users/u1');
    page.chip.dispose();
  });

  it('shows a header line with the listener count and no duplicate count when there are none', () => {
    const page = setup();
    toggle(page.root);
    page.push([
      attach('e1', 'l1', { kind: 'doc', path: 'users/u1' }, [{ kind: 'tag', name: 'ProfileCard' }]),
      attach('e2', 'l2', { kind: 'query', collection: 'todos' }, [{ kind: 'tag', name: 'TodoList', element: '#todos' }]),
    ]);

    const header = page.root.querySelector('[data-listener-panel] .state-label');
    expect(header?.textContent).toBe('2 listeners');
    page.chip.dispose();
  });

  it('uses singular phrasing for one listener', () => {
    const page = setup();
    toggle(page.root);
    page.push([attach('e1', 'l1', { kind: 'doc', path: 'users/u1' }, [{ kind: 'tag', name: 'ProfileCard' }])]);

    const header = page.root.querySelector('[data-listener-panel] .state-label');
    expect(header?.textContent).toBe('1 listener');
    page.chip.dispose();
  });

  it('adds the duplicate count to the header and an incident line first, from the incident', () => {
    const page = setup({
      incidents: (events) => {
        const attachIds = events
          .filter((event) => (event as { kind: string }).kind === 'listener_attach')
          .map((event) => (event as { id: string }).id);
        return [{
          fingerprint: 'fp1',
          pattern: 'duplicate-listener',
          confidence: 'high',
          severity: 'warning',
          service: 'firestore',
          method: 'listen',
          targetFingerprint: 'conversations',
          actor: { kind: 'unknown' },
          authLens: 'app',
          authUid: null,
          count: 2,
          windowMs: 5000,
          evidenceEventIds: attachIds,
        } as unknown as ActivityIncident];
      },
    });
    toggle(page.root);
    page.push([
      attach('e1', 'l1', { kind: 'query', collection: 'conversations' }, [{ kind: 'tag', name: 'ChatPage' }]),
      attach('e2', 'l2', { kind: 'query', collection: 'conversations' }, [{ kind: 'tag', name: 'ChatPage' }]),
    ]);

    const panel = page.root.querySelector('[data-listener-panel]');
    expect(panel?.querySelector('.state-label')?.textContent).toBe('2 listeners · 1 duplicate');
    const incidentRow = panel?.querySelector('.listener-row.incident');
    expect(incidentRow?.querySelector('.listener-label')?.textContent).toBe('duplicate');
    expect(incidentRow?.querySelector('.listener-target')?.textContent).toBe('conversations (query)');
    expect(incidentRow?.querySelector('.listener-mark')?.getAttribute('title'))
      .toBe('conversations (query) attached twice by ChatPage');
    page.chip.dispose();
  });

  it('phrases a churn incident from the incident window and count', () => {
    const page = setup({
      incidents: (events) => {
        const attachIds = events
          .filter((event) => (event as { kind: string }).kind === 'listener_attach')
          .map((event) => (event as { id: string }).id);
        return [{
          fingerprint: 'fp1',
          pattern: 'listener-churn',
          confidence: 'high',
          severity: 'warning',
          service: 'firestore',
          method: 'listen',
          targetFingerprint: 'presence',
          actor: { kind: 'unknown' },
          authLens: 'app',
          authUid: null,
          count: 40,
          windowMs: 10_000,
          evidenceEventIds: attachIds,
        } as unknown as ActivityIncident];
      },
    });
    toggle(page.root);
    page.push([attach('e1', 'l1', { kind: 'doc', path: '/presence' }, [{ kind: 'tag', name: 'PresenceBadge' }])]);

    const incidentRow = page.root.querySelector('[data-listener-panel] .listener-row.incident');
    expect(incidentRow?.querySelector('.listener-label')?.textContent).toBe('churn');
    expect(incidentRow?.querySelector('.listener-mark')?.getAttribute('title'))
      .toBe('/presence reattached 40 times in 10s');
    page.chip.dispose();
  });

  it('groups listeners by owner and orders groups by total deliveries, capped at six lines', () => {
    const page = setup();
    toggle(page.root);
    const events: SandboxEvent[] = [];
    for (let i = 0; i < 4; i++) {
      events.push(attach(`chat-${i}`, `chat-l${i}`, { kind: 'doc', path: `conversations/c${i}` }, [{ kind: 'tag', name: 'ChatPage' }]));
    }
    for (let i = 0; i < 2; i++) {
      events.push(attach(`side-${i}`, `side-l${i}`, { kind: 'doc', path: `users/u${i}` }, [{ kind: 'tag', name: 'Sidebar' }]));
    }
    events.push(attach('extra-1', 'extra-l1', { kind: 'doc', path: 'org/o1' }, [{ kind: 'tag', name: 'OrgPanel' }]));
    page.push(events);
    // Give ChatPage's listeners the most deliveries so it sorts first.
    page.push([
      delivery('d1', 'chat-l0', { kind: 'doc', path: 'conversations/c0' }),
      delivery('d2', 'chat-l0', { kind: 'doc', path: 'conversations/c0' }),
      delivery('d3', 'chat-l1', { kind: 'doc', path: 'conversations/c1' }),
    ]);

    const panel = page.root.querySelector('[data-listener-panel]')!;
    const rows = [...panel.querySelectorAll('.listener-row')];
    expect(rows.length).toBeLessThanOrEqual(4);
    const cells = [...rows[0].children].map((cell) => cell.textContent);
    expect(cells[0]).toBe('01');
    expect(cells[1]).toBe('ChatPage');
    expect(cells[2]).toBe('4 targets');
    expect(cells[3]).toBe('4');
    expect(cells[4]).toBe('3');
    const counts = [...rows[0].querySelectorAll('.listener-count')]
      .map((cell) => cell.getAttribute('title'));
    expect(counts).toEqual(['4 listeners', '3 deliveries']);
    // One header line, the rows, and the Studio link: six lines at most.
    expect(2 + rows.length).toBeLessThanOrEqual(6);
    expect(panel.lastElementChild?.className).toContain('listener-link');
    page.chip.dispose();
  });

  it('shows the collapsed chip a listener count signal, red when a listener has an incident', () => {
    const page = setup({
      incidents: (events) => {
        const attachIds = events
          .filter((event) => (event as { kind: string }).kind === 'listener_attach')
          .map((event) => (event as { id: string }).id);
        return [{
          fingerprint: 'fp1',
          pattern: 'duplicate-listener',
          confidence: 'high',
          severity: 'warning',
          service: 'firestore',
          method: 'listen',
          targetFingerprint: 'conversations',
          actor: { kind: 'unknown' },
          authLens: 'app',
          authUid: null,
          count: 2,
          windowMs: 5000,
          evidenceEventIds: attachIds,
        } as unknown as ActivityIncident];
      },
    });
    expect(page.root.querySelector('[data-listener-count]')).toBeNull();

    toggle(page.root);
    page.push([
      attach('e1', 'l1', { kind: 'query', collection: 'conversations' }, [{ kind: 'tag', name: 'ChatPage' }]),
      attach('e2', 'l2', { kind: 'query', collection: 'conversations' }, [{ kind: 'tag', name: 'ChatPage' }]),
    ]);

    // Collapse to see the chip's own signal strip.
    page.root.querySelector<HTMLButtonElement>('[data-collapse]')!.click();
    const signal = page.root.querySelector('[data-listener-count]');
    expect(signal?.textContent).toBe('2 listeners');
    expect(signal?.classList.contains('error')).toBe(true);
    page.chip.dispose();
  });

  it('links the Studio panel to the listeners view, or renders text when Studio is disabled', () => {
    const page = setup({ studioUrl: 'https://studio.example/app' });
    toggle(page.root);
    page.push([attach('e1', 'l1', { kind: 'doc', path: 'users/u1' }, [{ kind: 'tag', name: 'ProfileCard' }])]);
    const link = page.root.querySelector<HTMLAnchorElement>('[data-listener-panel] [data-open-listeners-studio]');
    expect(link?.getAttribute('href')).toBe('https://studio.example/app?view=listeners');
    expect(link?.getAttribute('target')).toBe('_blank');
    page.chip.dispose();

    const disabledPage = setup({ studioUrl: null });
    toggle(disabledPage.root);
    disabledPage.push([attach('e1', 'l1', { kind: 'doc', path: 'users/u1' }, [{ kind: 'tag', name: 'ProfileCard' }])]);
    const disabledLink = disabledPage.root.querySelector('[data-listener-panel] [data-open-listeners-studio]');
    expect(disabledLink?.tagName).toBe('SPAN');
    expect(disabledLink?.getAttribute('aria-disabled')).toBe('true');
    disabledPage.chip.dispose();
  });

  it('shows a single line when the mode is enabled with no listeners', () => {
    const page = setup();
    toggle(page.root);
    page.push([]);
    const panel = page.root.querySelector('[data-listener-panel]');
    expect(panel?.textContent?.trim()).toBe('No listeners');
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

  it('copies a row as one plain-text line', () => {
    const page = setup();
    toggle(page.root);
    page.push([
      attach('e1', 'l1', { kind: 'doc', path: 'users/u1' }, [{ kind: 'tag', name: 'ProfileCard' }]),
      attach('e2', 'l2', { kind: 'doc', path: 'users/u1' }, [{ kind: 'tag', name: 'ProfileCard' }]),
    ]);
    page.root.querySelector<HTMLButtonElement>('[data-listener-panel] [data-copy-listener]')!.click();
    expect(page.copied).toEqual(['ProfileCard · users/u1 · 2 listeners · 0 deliveries']);
    page.chip.dispose();
  });

  it('hides a dismissed row until a new listener attaches on it', () => {
    const page = setup();
    toggle(page.root);
    page.push([attach('e1', 'l1', { kind: 'doc', path: 'users/u1' }, [{ kind: 'tag', name: 'ProfileCard' }])]);
    expect(page.root.querySelectorAll('[data-listener-panel] .listener-row')).toHaveLength(1);

    page.root.querySelector<HTMLButtonElement>('[data-listener-panel] [data-dismiss-listener]')!.click();
    expect(page.root.querySelectorAll('[data-listener-panel] .listener-row')).toHaveLength(0);

    // A delivery leaves the row's listener set alone, so the row stays hidden.
    page.push([delivery('d1', 'l1', { kind: 'doc', path: 'users/u1' })]);
    expect(page.root.querySelectorAll('[data-listener-panel] .listener-row')).toHaveLength(0);

    page.push([attach('e2', 'l2', { kind: 'doc', path: 'users/u1' }, [{ kind: 'tag', name: 'ProfileCard' }])]);
    const rows = page.root.querySelectorAll('[data-listener-panel] .listener-row');
    expect(rows).toHaveLength(1);
    expect(rows[0].querySelector('.listener-count')?.textContent).toBe('2');
    page.chip.dispose();
  });

  it('marks an owner row whose listeners are part of an incident', () => {
    const page = setup({
      incidents: (events) => {
        const attachIds = events
          .filter((event) => (event as { kind: string }).kind === 'listener_attach')
          .map((event) => (event as { id: string }).id);
        return [{
          fingerprint: 'fp1',
          pattern: 'duplicate-listener',
          confidence: 'high',
          severity: 'warning',
          service: 'firestore',
          method: 'listen',
          targetFingerprint: 'conversations',
          actor: { kind: 'unknown' },
          authLens: 'app',
          authUid: null,
          count: 2,
          windowMs: 5000,
          evidenceEventIds: attachIds,
        } as unknown as ActivityIncident];
      },
    });
    toggle(page.root);
    page.push([
      attach('e1', 'l1', { kind: 'query', collection: 'conversations' }, [{ kind: 'tag', name: 'ChatPage' }]),
      attach('e2', 'l2', { kind: 'query', collection: 'conversations' }, [{ kind: 'tag', name: 'ChatPage' }]),
    ]);
    const ownerRow = page.root.querySelector('[data-listener-panel] .listener-row:not(.incident)');
    expect(ownerRow?.querySelector('.listener-label')?.textContent).toBe('ChatPage');
    expect(ownerRow?.querySelector('.listener-mark')?.textContent).toBe('!');
    expect(ownerRow?.querySelector('.listener-mark')?.getAttribute('title')).toBe('duplicate ×2');
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

// Install JSDOM globals before importing React or RTL.
import { JSDOM } from 'jsdom';
const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>', {
  pretendToBeVisual: true,
  url: 'http://localhost/studio/traffic',
});
const g = globalThis as any;
g.window = dom.window;
g.document = dom.window.document;
g.HTMLElement = dom.window.HTMLElement;
g.SVGElement = dom.window.SVGElement;
g.Element = dom.window.Element;
g.Node = dom.window.Node;
g.Event = dom.window.Event;
g.getComputedStyle = dom.window.getComputedStyle.bind(dom.window);
g.IS_REACT_ACT_ENVIRONMENT = true;
// The rules source hook asks the host for its rules; this test has no host.
g.fetch = async () => new Response('null', { status: 404 });

import { afterEach, describe, expect, it } from 'bun:test';
import { cleanup, render } from '@testing-library/react';
import { TrafficRow } from '@pyric/ui/traffic';
import type { LiveHostStatus } from 'pyric/sandbox/internal';
import { LiveRowDetail, OutcomeCell, TargetCell } from '../../../src/features/traffic/TrafficLiveRow.js';
import { fromOptions, inFromScope, methodLabel } from '../../../src/features/traffic/live-row.js';
import type { StudioTrafficEvent } from '../../../src/features/traffic/verdict.js';

afterEach(() => cleanup());

type LiveClient = NonNullable<LiveHostStatus['clients']>[number];

const CLIENTS: LiveClient[] = [
  { kind: 'browser', clientId: 'profile-a', label: '/dashboard', user: 'uid-a', email: 'a@example.com', lastSeen: 1 },
  { kind: 'browser', clientId: 'profile-b', label: '/checkout', user: 'uid-b', lastSeen: 1 },
  { kind: 'node', clientId: 'journey-1', label: 'server.mjs', user: null, lastSeen: 1 },
];

const LIVE: LiveHostStatus = {
  projectId: 'demo-project',
  configProjectId: 'demo-project',
  configSource: '.firebaserc',
  appProjectIds: ['demo-project'],
  billed: { reads: 0, writes: 0, deliveries: 0 },
  clients: CLIENTS,
};

function event(id: string, overrides: Partial<StudioTrafficEvent> & Record<string, unknown>): StudioTrafficEvent {
  return {
    id,
    kind: 'operation',
    service: 'firestore',
    at: 1_700_000_000_000,
    method: 'getDoc',
    path: 'items/one',
    auth: null,
    result: 'allow',
    reasons: [],
    origin: 'user',
    operationContext: { source: { kind: 'app' }, authLens: { mode: 'app-session' } },
    rulesDisposition: { kind: 'not-applicable' },
    ...overrides,
  } as StudioTrafficEvent;
}

const ok = { projectId: 'demo-project', outcome: { status: 'ok' } };
const denied = { projectId: 'demo-project', outcome: { status: 'error', code: 'permission-denied' } };

const EVENTS: Record<string, StudioTrafficEvent> = {
  fromA: event('from-a', { production: ok, auth: { uid: 'uid-a' }, caller: { kind: 'page', pageId: 'tab-1', clientId: 'profile-a' } }),
  fromB: event('from-b', {
    production: denied,
    method: 'updateDoc',
    auth: { uid: 'uid-b' },
    caller: { kind: 'page', pageId: 'tab-2', clientId: 'profile-b' },
  }),
  fromNode: event('from-node', {
    production: ok,
    method: 'DocumentReference.set',
    caller: { kind: 'node', clientId: 'journey-1' },
    operationContext: { source: { kind: 'app' }, authLens: { mode: 'admin' } },
  }),
  sandboxDeny: event('sandbox-deny', {
    result: 'deny',
    method: 'update',
    caller: { kind: 'studio' },
    rulesDisposition: { kind: 'evaluated', verdict: 'deny' },
  }),
  service: event('service', { service: 'auth', method: 'createUserWithEmailAndPassword', path: '', caller: { kind: 'mcp' } }),
};

/** Each child of a row, named by the hook it carries. */
function columns(row: Element): string[] {
  return [...row.children].map((cell) => {
    const hook = [...cell.attributes].find((attribute) => attribute.name.startsWith('data-pyric-traffic-'));
    if (hook !== undefined) return hook.name;
    return cell.classList.contains('traffic__target') ? 'target' : cell.classList.contains('traffic__verdict') ? 'outcome' : cell.tagName;
  });
}

function liveRow(item: StudioTrafficEvent, expanded = false) {
  return (
    <TrafficRow
      key={item.id}
      event={item}
      expanded={expanded}
      renderLead={(e) => <TargetCell event={e as StudioTrafficEvent} />}
      formatMethod={methodLabel}
      renderClassification={(e) => <OutcomeCell event={e as StudioTrafficEvent} />}
    />
  );
}

describe('Traffic rows on a live host', () => {
  it('lays every row on the same seven columns, outcome or none', () => {
    const { container } = render(<div>{Object.values(EVENTS).map((item) => liveRow(item))}</div>);
    const rows = [...container.querySelectorAll('[data-pyric-traffic-row]')];
    expect(rows).toHaveLength(Object.keys(EVENTS).length);
    const expected = [
      'data-pyric-traffic-time',
      'target',
      'data-pyric-traffic-service',
      'data-pyric-traffic-method',
      'data-pyric-traffic-path',
      'outcome',
      'data-pyric-traffic-chevron',
    ];
    for (const row of rows) {
      expect(columns(row)).toEqual(expected);
      expect(row.hasAttribute('data-pyric-lead')).toBe(true);
      expect(row.getAttribute('aria-expanded')).toBe('false');
    }
  });

  it('shows an Admin SDK method without its class and keeps the full name on the row', () => {
    const { container } = render(liveRow(EVENTS.fromNode!));
    const row = container.querySelector('[data-pyric-traffic-row]')!;
    const method = row.querySelector('[data-pyric-traffic-method]')!;
    expect(method.textContent).toBe('set');
    expect(method.getAttribute('title')).toBe('DocumentReference.set');
    expect(row.getAttribute('data-pyric-method')).toBe('DocumentReference.set');
    expect(methodLabel('onDisconnect.set')).toBe('onDisconnect.set');
  });

  it('marks an expanded row and leaves a sandbox host row as it was', () => {
    const { container } = render(
      <div>
        {liveRow(EVENTS.fromB!, true)}
        <TrafficRow event={EVENTS.fromA!} />
      </div>,
    );
    const [expanded, sandboxHost] = [...container.querySelectorAll('[data-pyric-traffic-row]')];
    expect(expanded!.getAttribute('aria-expanded')).toBe('true');
    expect(sandboxHost!.hasAttribute('aria-expanded')).toBe(false);
    expect(sandboxHost!.hasAttribute('data-pyric-lead')).toBe(false);
    expect(sandboxHost!.querySelector('[data-pyric-badge-kind]')).not.toBeNull();
    expect(sandboxHost!.querySelector('[data-pyric-traffic-chevron]')).toBeNull();
  });
});

describe("a live row's expansion", () => {
  function facts(item: StudioTrafficEvent): Record<string, string> {
    const { container } = render(<LiveRowDetail event={item} live={LIVE} onClose={() => {}} />);
    const entries = [...container.querySelectorAll('[data-pyric-row-fact]')].map((fact) => [
      fact.getAttribute('data-pyric-row-fact')!,
      fact.querySelector('dd')!.textContent ?? '',
    ]);
    cleanup();
    return Object.fromEntries(entries);
  }

  it("names the listed client that sent the op and the op's account", () => {
    const fromA = facts(EVENTS.fromA!);
    expect(fromA.source).toContain('/dashboard');
    expect(fromA.identity).toBe('a@example.com');
    expect(fromA.method).toBe('getDoc');
    expect(fromA.path).toBe('items/one');
    expect(fromA.target).toContain('demo-project');

    // No email reported for the uid: the uid itself.
    const fromB = facts(EVENTS.fromB!);
    expect(fromB.source).toContain('/checkout');
    expect(fromB.identity).toBe('uid-b');
    expect(fromB.outcome).toContain('permission-denied');

    const fromNode = facts(EVENTS.fromNode!);
    expect(fromNode.source).toContain('server.mjs');
    expect(fromNode.method).toBe('DocumentReference.set');
  });

  it('lists the same fields for an op the sandbox served', () => {
    const sandbox = facts(EVENTS.service!);
    expect(Object.keys(sandbox)).toEqual(['source', 'identity', 'method', 'target', 'path', 'outcome', 'time']);
    expect(sandbox.target).not.toContain('demo-project');
  });
});

describe('the "From" scope', () => {
  const events = Object.values(EVENTS);
  const kept = (value: string) => inFromScope(events, value).map((item) => item.id).sort();

  it('offers each listed client and each uid, by client id and uid', () => {
    const options = fromOptions(CLIENTS, events);
    expect(options.clients.map((option) => option.value)).toEqual([
      'client:page:profile-a',
      'client:page:profile-b',
      'client:node:journey-1',
      'agents',
    ]);
    expect(options.users.map((option) => option.value)).toEqual(['user:uid-a', 'user:uid-b', 'signed-out']);
    for (const option of [...options.clients, ...options.users]) expect(option.value).not.toContain('@');
  });

  it('keeps exactly the chosen client\'s or user\'s rows', () => {
    expect(kept('all')).toEqual(events.map((item) => item.id).sort());
    expect(kept('client:page:profile-b')).toEqual(['from-b']);
    expect(kept('client:node:journey-1')).toEqual(['from-node']);
    expect(kept('user:uid-a')).toEqual(['from-a']);
    expect(kept('signed-out')).toEqual(['from-node', 'sandbox-deny', 'service']);
    expect(kept('agents')).toEqual(['sandbox-deny', 'service']);
    expect(kept('not-a-scope')).toEqual(events.map((item) => item.id).sort());
  });
});

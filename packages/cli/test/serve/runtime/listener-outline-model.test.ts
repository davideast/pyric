import { describe, expect, it } from 'bun:test';
import type { SandboxEvent } from 'pyric/sandbox';
import type { ActivityIncident } from 'pyric/firestore/internal';
import { listenerOutlines } from '../../../src/serve/runtime/listener-outline-model.js';

const auth = { uid: null, token: null };

type Target = { kind: 'doc'; path: string } | { kind: 'query'; collection: string };

function attach(id: string, listenerId: string, target: Target, owners: unknown[]): SandboxEvent {
  return {
    kind: 'listener_attach',
    id,
    at: 1,
    listenerId,
    target,
    auth,
    owners,
  } as unknown as SandboxEvent;
}

function delivery(id: string, listenerId: string, target: Target, owners?: unknown[]): SandboxEvent {
  const event: Record<string, unknown> = {
    kind: 'snapshot_delivery',
    id,
    at: 2,
    listenerId,
    target,
    auth,
    addedCount: 1,
    modifiedCount: 0,
    removedCount: 0,
    size: 1,
  };
  if (owners !== undefined) event.owners = owners;
  return event as unknown as SandboxEvent;
}

describe('listenerOutlines', () => {
  it('labels a tagged listener and a region-owned listener with their targets and counts', () => {
    const events: SandboxEvent[] = [
      attach('e1', 'l1', { kind: 'query', collection: 'todos' }, [{ kind: 'tag', name: 'TodoList', element: '#todos' }]),
      delivery('e2', 'l1', { kind: 'query', collection: 'todos' }),
      attach('e3', 'l2', { kind: 'doc', path: 'users/u1' }, [{ kind: 'frame', file: '/src/profile.ts', line: 12, function: 'useProfile' }]),
      delivery('e4', 'l2', { kind: 'doc', path: 'users/u1' }, [{ kind: 'regions', selectors: ['#profile'] }]),
    ];

    const outlines = listenerOutlines(events, []);

    expect(outlines).toHaveLength(2);
    expect(outlines[0]).toMatchObject({
      listenerId: 'l1',
      label: 'TodoList',
      target: 'todos',
      isQuery: true,
      deliveryCount: 1,
      selectors: ['#todos'],
    });
    expect(outlines[1]).toMatchObject({
      listenerId: 'l2',
      label: 'useProfile',
      target: 'users/u1',
      isQuery: false,
      deliveryCount: 1,
      selectors: ['#profile'],
    });
  });

  it('prefers a component owner element and name over a tag', () => {
    const events = [
      attach('e1', 'l1', { kind: 'query', collection: 'todos' }, [
        { kind: 'tag', name: 'div', element: '#wrap' },
        { kind: 'component', name: 'TodoList', element: '#list', path: '/src/TodoList.tsx' },
      ]),
    ];
    const outlines = listenerOutlines(events, []);
    expect(outlines[0]?.label).toBe('TodoList');
    expect(outlines[0]?.selectors).toEqual(['#list']);
  });

  it('drops a detached listener', () => {
    const events: SandboxEvent[] = [
      attach('e1', 'l1', { kind: 'query', collection: 'todos' }, [{ kind: 'tag', name: 'A', element: '#a' }]),
      attach('e2', 'l2', { kind: 'query', collection: 'todos' }, [{ kind: 'tag', name: 'B', element: '#b' }]),
      {
        kind: 'listener_detach',
        id: 'e3',
        at: 3,
        listenerId: 'l2',
        target: { kind: 'query', collection: 'todos' },
        auth,
      } as unknown as SandboxEvent,
    ];
    const outlines = listenerOutlines(events, []);
    expect(outlines.map((outline) => outline.listenerId)).toEqual(['l1']);
  });

  it('marks a listener whose attach is evidence for a duplicate-listener incident', () => {
    const events = [
      attach('e1', 'l1', { kind: 'query', collection: 'todos' }, [{ kind: 'tag', name: 'A', element: '#a' }]),
      attach('e2', 'l2', { kind: 'query', collection: 'todos' }, [{ kind: 'tag', name: 'B', element: '#b' }]),
    ];
    const incident = {
      pattern: 'duplicate-listener',
      count: 2,
      evidenceEventIds: ['e1', 'e2'],
    } as unknown as ActivityIncident;

    const outlines = listenerOutlines(events, [incident]);
    expect(outlines[0]?.incident).toEqual({ pattern: 'duplicate-listener', count: 2 });
    expect(outlines[1]?.incident).toEqual({ pattern: 'duplicate-listener', count: 2 });
  });

  it('reports a listener with no attributable element as having no selectors', () => {
    const events = [attach('e1', 'l1', { kind: 'doc', path: 'users/u1' }, [{ kind: 'frame', file: '/src/a.ts', line: 3 }])];
    const outlines = listenerOutlines(events, []);
    expect(outlines[0]?.selectors).toEqual([]);
    expect(outlines[0]?.label).toBe('/src/a.ts');
  });
});

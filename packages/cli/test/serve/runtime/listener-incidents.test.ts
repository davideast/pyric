import { describe, expect, it } from 'bun:test';
import type { SandboxEvent } from 'pyric/sandbox';
import { incidentsFromEvents } from '../../../src/serve/runtime/listener-incidents.js';

const auth = { uid: 'u1', token: { uid: 'u1' } };

function attach(id: string, listenerId: string, collection: string, at: number): SandboxEvent {
  return {
    kind: 'listener_attach',
    id,
    at,
    listenerId,
    target: { kind: 'query', collection },
    auth,
    actor: { kind: 'app' },
  } as unknown as SandboxEvent;
}

describe('incidentsFromEvents', () => {
  it('reports no incident for a quiet history', () => {
    expect(incidentsFromEvents([attach('e1', 'l1', 'todos', 1)])).toEqual([]);
  });

  it('reports a duplicate-listener incident citing the attaches as evidence', () => {
    const events = [
      attach('e1', 'l1', 'todos', 1),
      attach('e2', 'l2', 'todos', 2),
      attach('e3', 'l3', 'todos', 3),
      attach('e4', 'l4', 'todos', 4),
      attach('e5', 'l5', 'todos', 5),
    ];
    const incidents = incidentsFromEvents(events);
    const duplicate = incidents.find((incident) => incident.pattern === 'duplicate-listener');
    expect(duplicate).toBeDefined();
    expect(duplicate?.evidenceEventIds).toContain('e1');
  });
});

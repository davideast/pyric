import { describe, expect, it } from 'bun:test';
import type { SandboxEvent } from 'pyric/sandbox';
import { createListenerIncidents, incidentsFromEvents } from '../../../src/serve/runtime/listener-incidents.js';

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

describe('incremental listener incidents', () => {
  it('preserves snapshot semantics across hydration, duplicate delivery, and session reset', () => {
    const monitor = createListenerIncidents();
    const history: SandboxEvent[] = [];
    const batches: SandboxEvent[][] = [
      [attach('a1', 'l1', 'todos', 1), attach('a2', 'l2', 'todos', 2)],
      [attach('a3', 'l3', 'todos', 3)],
      [attach('a3', 'l3', 'todos', 3)],
      [{ kind: 'session_boundary', id: 'reset', at: 4, phase: 'reset', priorOpCount: 3 }],
      [attach('b1', 'l1', 'todos', 5), attach('b2', 'l2', 'todos', 6)],
      [attach('b3', 'l3', 'todos', 7)],
    ];
    try {
      for (const batch of batches) {
        history.push(...batch);
        monitor.append(batch);
        expect(monitor.read()).toEqual(incidentsFromEvents(history));
      }
      expect(monitor.read()).toHaveLength(2);
    } finally {
      monitor.dispose();
    }
  });
});

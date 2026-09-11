/** Listener incidents — the activity monitor run over a Studio event snapshot. */
import { describe, expect, it } from 'bun:test';
import type { SandboxEvent } from 'pyric/sandbox';
import { incidentsForTarget, listenerIncidents, repeatedReadIncidents } from './listener-incidents.js';

const CONTEXT = { source: { kind: 'app' as const }, authLens: { mode: 'app-session' as const } };

function attach(id: string, listenerId: string, at: number): SandboxEvent {
  return {
    kind: 'listener_attach',
    id,
    at,
    listenerId,
    target: { kind: 'doc', path: 'notes/dup' },
    auth: null,
    operationContext: CONTEXT,
  } as unknown as SandboxEvent;
}

describe('listenerIncidents', () => {
  it('reports a duplicate-listener incident for three attaches on the same doc', () => {
    const events = [attach('e1', 'l1', 0), attach('e2', 'l2', 10), attach('e3', 'l3', 20)];
    const incidents = listenerIncidents(events);
    const duplicate = incidents.find((incident) => incident.pattern === 'duplicate-listener');
    expect(duplicate).toBeDefined();
    expect(duplicate?.count).toBe(3);
  });

  it('matches the duplicate incident to its listener target', () => {
    const events = [attach('e1', 'l1', 0), attach('e2', 'l2', 10), attach('e3', 'l3', 20)];
    const incidents = listenerIncidents(events);
    const matched = incidentsForTarget(incidents, 'notes/dup');
    expect(matched).toHaveLength(1);
    expect(matched[0]!.pattern).toBe('duplicate-listener');
  });

  it('does not match a target the incident does not name', () => {
    const events = [attach('e1', 'l1', 0), attach('e2', 'l2', 10), attach('e3', 'l3', 20)];
    const incidents = listenerIncidents(events);
    expect(incidentsForTarget(incidents, 'notes/other')).toHaveLength(0);
  });

  it('finds no incidents in a quiet stream', () => {
    expect(listenerIncidents([attach('e1', 'l1', 0)])).toEqual([]);
    expect(repeatedReadIncidents([])).toEqual([]);
  });
});

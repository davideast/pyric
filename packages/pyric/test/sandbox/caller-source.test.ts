/**
 * One scoping rule for the chip and Studio: a scope keeps exactly the events
 * of one client, one user, or one user on one client. A client is a
 * (kind, clientId) pair, so a page and a Node process that share an id, or a
 * service worker and its profile's pages, never read as one client.
 */
import { describe, expect, it } from 'bun:test';
import type { EventCaller } from '../../src/sandbox/index.js';
import { eventScope, type EventScope } from '../../src/sandbox/internal/index.js';

interface ScopedEvent {
  id: string;
  caller?: EventCaller;
  auth?: { uid: string } | null;
}

const events: ScopedEvent[] = [
  { id: 'a-tab1-u1', caller: { kind: 'page', pageId: 't1', clientId: 'profile-a' }, auth: { uid: 'u1' } },
  { id: 'a-tab2-u1', caller: { kind: 'page', pageId: 't2', clientId: 'profile-a' }, auth: { uid: 'u1' } },
  { id: 'a-tab2-out', caller: { kind: 'page', pageId: 't2', clientId: 'profile-a' }, auth: null },
  { id: 'b-tab3-u2', caller: { kind: 'page', pageId: 't3', clientId: 'profile-b' }, auth: { uid: 'u2' } },
  { id: 'sw-a-u1', caller: { kind: 'service-worker', clientId: 'profile-a' }, auth: { uid: 'u1' } },
  { id: 'node-1-u2', caller: { kind: 'node', clientId: 'page-3' }, auth: { uid: 'u2' } },
  { id: 'page-3-u2', caller: { kind: 'page', pageId: 't4', clientId: 'page-3' }, auth: { uid: 'u2' } },
  { id: 'unstamped-u1', auth: { uid: 'u1' } },
  { id: 'no-client-u1', caller: { kind: 'page', pageId: 't5' }, auth: { uid: 'u1' } },
];

const kept = (scope: EventScope) => events.filter(event => eventScope(event, scope)).map(event => event.id);

describe('eventScope', () => {
  it('all keeps every event', () => {
    expect(kept('all')).toEqual(events.map(event => event.id));
  });

  it('a client keeps every tab of one profile and nothing of another kind', () => {
    expect(kept({ client: { kind: 'page', clientId: 'profile-a' } })).toEqual(['a-tab1-u1', 'a-tab2-u1', 'a-tab2-out']);
    expect(kept({ client: { kind: 'service-worker', clientId: 'profile-a' } })).toEqual(['sw-a-u1']);
  });

  it('keys a client by kind and id, so a page and a Node process with one id stay apart', () => {
    expect(kept({ client: { kind: 'node', clientId: 'page-3' } })).toEqual(['node-1-u2']);
    expect(kept({ client: { kind: 'page', clientId: 'page-3' } })).toEqual(['page-3-u2']);
  });

  it('a user keeps that uid on every client, and null keeps signed-out calls', () => {
    expect(kept({ user: 'u1' })).toEqual(['a-tab1-u1', 'a-tab2-u1', 'sw-a-u1', 'unstamped-u1', 'no-client-u1']);
    expect(kept({ user: 'u2' })).toEqual(['b-tab3-u2', 'node-1-u2', 'page-3-u2']);
    expect(kept({ user: null })).toEqual(['a-tab2-out']);
  });

  it('a client and a user keep only that user on that client', () => {
    expect(kept({ client: { kind: 'page', clientId: 'profile-a' }, user: 'u1' })).toEqual(['a-tab1-u1', 'a-tab2-u1']);
    expect(kept({ client: { kind: 'page', clientId: 'profile-a' }, user: null })).toEqual(['a-tab2-out']);
    expect(kept({ client: { kind: 'page', clientId: 'profile-b' }, user: 'u1' })).toEqual([]);
  });

  it('an event with no auth field is not a signed-out call', () => {
    const noAuth: ScopedEvent = { id: 'x', caller: { kind: 'page', clientId: 'profile-a' } };
    expect(eventScope(noAuth, { user: null })).toBe(false);
    expect(eventScope(noAuth, { client: { kind: 'page', clientId: 'profile-a' } })).toBe(true);
  });
});

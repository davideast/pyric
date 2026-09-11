/** Listener grouping, pure fold tests. */
import { describe, expect, it } from 'bun:test';
import type { ActiveListener, ListenerOwner } from 'pyric/sandbox';
import { formatListenerTarget, groupIdentityFor, groupListeners } from './listener-groups.js';

function listener(overrides: Partial<ActiveListener> & { id: string }): ActiveListener {
  return {
    service: 'firestore',
    target: 'notes/one',
    actor: { kind: 'app' },
    authLens: { mode: 'app-session' },
    attachedAt: 0,
    deliveryCount: 0,
    suppressedCount: 0,
    ...overrides,
  };
}

function owned(id: string, owners: readonly ListenerOwner[]): ActiveListener {
  return listener({ id, owners });
}

describe('groupIdentityFor', () => {
  it('prefers a component owner, subtitled by its render path', () => {
    const identity = groupIdentityFor(
      owned('l1', [{ kind: 'component', name: 'NotesList', path: ['App', 'NotesList'] }]),
    );
    expect(identity).toEqual({
      key: 'component:NotesList',
      label: 'NotesList',
      subtitle: 'App › NotesList',
    });
  });

  it('falls back to a tag owner', () => {
    expect(groupIdentityFor(owned('l2', [{ kind: 'tag', name: 'sidebar' }])).label).toBe('sidebar');
  });

  it('labels by the target alone when only a frame owns the listener', () => {
    const identity = groupIdentityFor(
      owned('l3', [{ kind: 'frame', file: 'app.js', line: 10, function: 'loadNotes' }]),
    );
    expect(identity.label).toBe('notes/one');
  });

  it('never labels a group by a frame function, an id, or "unattributed"', () => {
    const frameOwned = groupIdentityFor(
      owned('l4', [{ kind: 'frame', file: 'app.js', line: 10, function: 'loadNotes' }]),
    );
    expect(frameOwned.label).not.toBe('loadNotes');
    expect(frameOwned.label).not.toBe('app.js');
    const unowned = groupIdentityFor(listener({ id: 'l5' }));
    expect(unowned.label).toBe('notes/one');
    expect(unowned.label).not.toBe('l5');
  });

  it('labels a query target the way the app wrote it', () => {
    const identity = groupIdentityFor(
      listener({ id: 'l6', target: { collection: 'conversations', query: true } }),
    );
    expect(identity.label).toBe('conversations (query)');
  });
});

describe('groupListeners', () => {
  it('groups by component, by tag, and by target for the rest', () => {
    const listeners = [
      owned('l1', [{ kind: 'component', name: 'NotesList' }]),
      owned('l2', [{ kind: 'tag', name: 'sidebar' }]),
      listener({ id: 'l3', target: 'todos/one', owners: [{ kind: 'frame', file: 'app.js', line: 4 }] }),
    ];
    const groups = groupListeners(listeners);
    expect(groups.map((g) => g.identity.label).sort()).toEqual([
      'NotesList',
      'sidebar',
      'todos/one',
    ]);
  });

  it('files two listeners on the same target under one group', () => {
    const groups = groupListeners([listener({ id: 'l1' }), listener({ id: 'l2' })]);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.listeners.map((l) => l.id)).toEqual(['l1', 'l2']);
  });

  it('filters by service', () => {
    const listeners = [
      listener({ id: 'l1', service: 'firestore' }),
      listener({ id: 'l2', service: 'database', target: '/rooms/1' }),
    ];
    const groups = groupListeners(listeners, { service: 'database' });
    expect(groups.flatMap((g) => g.listeners.map((l) => l.id))).toEqual(['l2']);
  });

  it('filters by target prefix', () => {
    const listeners = [
      listener({ id: 'l1', target: 'notes/one' }),
      listener({ id: 'l2', target: 'todos/one' }),
    ];
    const groups = groupListeners(listeners, { targetPrefix: 'notes' });
    expect(groups.flatMap((g) => g.listeners.map((l) => l.id))).toEqual(['l1']);
  });
});

describe('formatListenerTarget', () => {
  it('renders a plain path as-is', () => {
    expect(formatListenerTarget('notes/one')).toBe('notes/one');
  });

  it('marks a query target', () => {
    expect(formatListenerTarget({ collection: 'notes', query: true })).toBe('notes (query)');
    expect(formatListenerTarget({ collection: 'notes' })).toBe('notes');
  });
});

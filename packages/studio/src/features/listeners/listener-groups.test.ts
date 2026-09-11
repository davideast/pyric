/** Listener grouping, pure fold tests. */
import { describe, expect, it } from 'bun:test';
import type { ActiveListener } from 'pyric/sandbox';
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

describe('groupIdentityFor', () => {
  it('prefers a component owner, subtitled by its path', () => {
    const identity = groupIdentityFor([
      { kind: 'component', name: 'NotesList', path: 'src/NotesList.tsx' } as never,
    ]);
    expect(identity).toEqual({ key: 'component:src/NotesList.tsx:NotesList', label: 'NotesList', subtitle: 'src/NotesList.tsx' });
  });

  it('falls back to a tag owner', () => {
    const identity = groupIdentityFor([{ kind: 'tag', name: 'sidebar' }]);
    expect(identity.label).toBe('sidebar');
  });

  it('falls back to a frame function, then its file', () => {
    const withFn = groupIdentityFor([{ kind: 'frame', file: 'app.js', line: 10, function: 'loadNotes' }]);
    expect(withFn.label).toBe('loadNotes');
    const noFn = groupIdentityFor([{ kind: 'frame', file: 'app.js', line: 10 }]);
    expect(noFn.label).toBe('app.js');
  });

  it('is unattributed when no owners are recorded', () => {
    expect(groupIdentityFor(undefined).label).toBe('Unattributed');
    expect(groupIdentityFor([]).label).toBe('Unattributed');
  });
});

describe('groupListeners', () => {
  it('groups three listeners under a component, a tag, and a frame label', () => {
    const listeners = [
      listener({
        id: 'l1',
        owners: [{ kind: 'component', name: 'NotesList', path: 'src/NotesList.tsx' } as never],
      }),
      listener({ id: 'l2', owners: [{ kind: 'tag', name: 'sidebar' }] }),
      listener({ id: 'l3', owners: [{ kind: 'frame', file: 'app.js', line: 4 }] }),
    ];
    const groups = groupListeners(listeners);
    expect(groups).toHaveLength(3);
    expect(groups.map((g) => g.identity.label).sort()).toEqual(['NotesList', 'app.js', 'sidebar']);
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

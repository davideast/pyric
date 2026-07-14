import { describe, expect, it } from 'bun:test';
import { routeForTarget, targetForLocation } from './navigation.js';

describe('Storage navigation intent', () => {
  it('round-trips a prefix distinctly from an object at the same path', () => {
    const prefix = { view: 'storage', kind: 'prefix', path: 'notes/note-01' } as const;
    const object = { view: 'storage', kind: 'object', path: 'notes/note-01' } as const;

    expect(routeForTarget(prefix)).toEqual({
      tab: 'storage',
      rest: ['notes', 'note-01'],
      query: { kind: 'prefix' },
    });
    expect(routeForTarget(object)).toEqual({
      tab: 'storage',
      rest: ['notes', 'note-01'],
    });
    expect(targetForLocation('/storage/notes/note-01?kind=prefix')).toEqual(prefix);
    expect(targetForLocation('/storage/notes/note-01')).toEqual(object);
  });
});

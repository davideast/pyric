import { expect, it } from 'bun:test';
import { BackendState } from '../../../src/database/sandbox/backend-state.js';
import { ChildListeners } from '../../../src/database/sandbox/child-listeners.js';
import { PersistenceState } from '../../../src/database/sandbox/persistence-state.js';
import { ValueListeners } from '../../../src/database/sandbox/value-listeners.js';

it('round-trips data and priority metadata without persisting listeners', () => {
  const source = new BackendState();
  source.tree.write('/items/a', { value: 1 });
  source.priorities.set('/items/a', 7);
  const encoded = new PersistenceState(
    source, new ValueListeners(source), new ChildListeners(source),
  ).exportState();

  const restored = new BackendState();
  const persistence = new PersistenceState(
    restored, new ValueListeners(restored), new ChildListeners(restored),
  );
  persistence.restore(encoded);
  expect(restored.tree.read('/items/a')).toEqual({ value: 1 });
  expect(restored.priorities.get('/items/a')).toBe(7);
  expect(restored.valueListeners.size).toBe(0);
  expect(restored.childListeners.size).toBe(0);
});

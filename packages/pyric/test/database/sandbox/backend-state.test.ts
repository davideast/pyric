import { expect, it } from 'bun:test';
import { BackendState } from '../../../src/database/sandbox/backend-state.js';

it('owns backend-local state and isolates failing write subscribers', () => {
  const first = new BackendState();
  const second = new BackendState();
  let notified = 0;
  first.writeSubscribers.add(() => { throw new Error('observational failure'); });
  first.writeSubscribers.add(() => { notified += 1; });
  first.tree.write('/value', 1);
  expect(() => first.notifyWrite()).not.toThrow();
  expect(notified).toBe(1);
  expect(second.tree.read('/value')).toBeNull();
});

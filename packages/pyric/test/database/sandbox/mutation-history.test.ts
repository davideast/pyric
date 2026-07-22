import { expect, it } from 'bun:test';
import { MutationHistory } from '../../../src/database/sandbox/mutation-history.js';

it('detects only overlapping mutations and releases retained history', () => {
  const history = new MutationHistory();
  const version = history.begin();
  history.mark('/items/a');
  expect(history.conflictsSince(version, '/items')).toBe(true);
  expect(history.conflictsSince(version, '/other')).toBe(false);
  expect(history.entries).toHaveLength(1);
  history.release(version);
  expect(history.entries).toHaveLength(0);
});

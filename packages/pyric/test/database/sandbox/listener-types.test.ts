import { expect, it } from 'bun:test';
import type {
  ChildListener,
  ValueListener,
  ValueListenerSnapshot,
} from '../../../src/database/sandbox/listener-types.js';

it('keeps listener records compatible with their delivery snapshot shapes', () => {
  const snapshots: ValueListenerSnapshot[] = [];
  const value: ValueListener = {
    id: 'value-1', auth: null, path: '/items', cb: (snapshot) => snapshots.push(snapshot),
  };
  const child: ChildListener = {
    id: 'child-1', auth: null, event: 'child_added', path: '/items', cb: () => {},
  };
  value.cb({ val: { a: 1 }, exists: true, key: 'items' });
  expect(snapshots).toHaveLength(1);
  expect(child.event).toBe('child_added');
});

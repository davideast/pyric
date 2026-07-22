import { expect, it } from 'bun:test';
import { DataSnapshot } from '../../src/database/data-snapshot.js';

it('keeps direct construction inert while exposing the Firebase-shaped surface', () => {
  const snapshot = new DataSnapshot();
  expect({ key: snapshot.key, size: snapshot.size, priority: snapshot.priority }).toEqual({
    key: null, size: 0, priority: null,
  });
  expect(snapshot.exists()).toBe(false);
  expect(snapshot.val()).toBeNull();
  expect(snapshot.exportVal()).toBeNull();
  expect(snapshot.forEach(() => true)).toBe(false);
});

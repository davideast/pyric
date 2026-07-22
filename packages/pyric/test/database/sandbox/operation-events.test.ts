import { expect, it } from 'bun:test';
import {
  canonicalPath,
  denyResultFor,
  OperationEvents,
} from '../../../src/database/sandbox/operation-events.js';

it('canonicalizes event paths and mints monotonically unique ids', () => {
  const events = new OperationEvents();
  expect(canonicalPath('items//a/')).toBe('/items/a');
  expect(denyResultFor('unsupported')).toBe('unsupported');
  expect(denyResultFor('deny')).toBe('deny');
  expect(events.nextListenerId()).not.toBe(events.nextListenerId());
  expect(events.nextGroupId('update')).toMatch(/^rtdb-update-/);
});

import { describe, expect, test } from 'bun:test';
import {
  allowedAmbientBinding,
  allowsDynamicAmbientAccess,
} from '../../../src/rules/modules/service-bindings.js';

describe('service ambient bindings', () => {
  test('keeps Storage fields generated from accepted capabilities fail-closed', () => {
    expect(allowedAmbientBinding('firebase.storage', ['request', 'resource', 'size'])).toBe(true);
    expect(allowedAmbientBinding('firebase.storage', ['request', 'resource', 'md5Hash'])).toBe(false);
  });

  test('allows dynamic keys only on intentionally open objects', () => {
    expect(allowsDynamicAmbientAccess('firebase.storage', ['request', 'resource', 'metadata'])).toBe(true);
    expect(allowsDynamicAmbientAccess('firebase.storage', ['request', 'resource'])).toBe(false);
    expect(allowsDynamicAmbientAccess('cloud.firestore', ['request', 'resource', 'data'])).toBe(true);
  });
});

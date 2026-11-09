import { describe, expect, test } from 'bun:test';
import {
  allowedAmbientBinding,
  allowsDynamicAmbientAccess,
} from '../../../src/rules/modules/service-bindings.js';

describe('service ambient bindings', () => {
  test('admits production-verified Storage request.resource fields while keeping unverified fields fail-closed', () => {
    for (const field of [
      'size',
      'name',
      'contentType',
      'metadata',
      'cacheControl',
      'contentDisposition',
      'contentEncoding',
      'contentLanguage',
      'bucket',
      'generation',
      'metageneration',
      'etag',
      'md5Hash',
      'crc32c',
      'storageClass',
    ]) {
      expect(allowedAmbientBinding('firebase.storage', ['request', 'resource', field]), field).toBe(true);
    }
    expect(allowedAmbientBinding('firebase.storage', ['request', 'resource', 'timeCreated'])).toBe(false);
    expect(allowedAmbientBinding('firebase.storage', ['request', 'resource', 'updated'])).toBe(false);
  });

  test('allows dynamic keys only on intentionally open objects', () => {
    expect(allowsDynamicAmbientAccess('firebase.storage', ['request', 'resource', 'metadata'])).toBe(true);
    expect(allowsDynamicAmbientAccess('firebase.storage', ['request', 'resource'])).toBe(false);
    expect(allowsDynamicAmbientAccess('cloud.firestore', ['request', 'resource', 'data'])).toBe(true);
  });
});

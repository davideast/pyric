/**
 * The shared Google endpoint catalog.
 *
 * Two sets come out of one table and they mean different things. Every catalog
 * host is matched on the wire by the net guard. Only the fingerprint subset
 * feeds the throwing frontend build check, because that check fails a build
 * outright and must not fire on a host an ordinary app can carry without any
 * Firebase SDK. Both sets are pinned literally below, so widening either one
 * is a deliberate edit to this file.
 */
import { describe, expect, it } from 'bun:test';
import {
  GOOGLE_ENDPOINT_CATALOG,
  SDK_FINGERPRINT_HOSTS,
  lookupGoogleEndpoint,
  matchesHostSuffix,
  normalizeHostname,
} from '../src/google-endpoints.js';

/** Every host in the catalog, which is the net guard's match set. */
const catalogHosts = (): string[] => GOOGLE_ENDPOINT_CATALOG.map((e) => e.host);

/** Hosts the throwing build check may fail a build over. */
const EXPECTED_FINGERPRINT_HOSTS = [
  'firebasedatabase.app',
  'fcmregistrations.googleapis.com',
  'firebaseinstallations.googleapis.com',
  'firebasevertexai.googleapis.com',
  'firestore.googleapis.com',
  'identitytoolkit.googleapis.com',
  'securetoken.googleapis.com',
];

/** Catalog hosts the throwing build check must never fail a build over, each
 *  with the ordinary non-SDK usage that would otherwise be a false positive. */
const EXPECTED_NON_FINGERPRINT_HOSTS = [
  '169.254.169.254', // infrastructure reference
  'aiplatform.googleapis.com', // a hand-written Vertex AI client
  'cloudfunctions.googleapis.com', // deployment tooling
  'cloudfunctions.net', // a bare callable URL
  'fcm.googleapis.com', // a server-side send
  'firebaseio.com', // a databaseURL config literal
  'firebasestorage.googleapis.com', // a download URL
  'metadata.google.internal', // infrastructure reference
  'storage.googleapis.com', // a public asset URL
];

describe('GOOGLE_ENDPOINT_CATALOG', () => {
  it('holds every host the guard matches, each with a service label', () => {
    expect(catalogHosts().sort()).toEqual(
      [...EXPECTED_FINGERPRINT_HOSTS, ...EXPECTED_NON_FINGERPRINT_HOSTS].sort(),
    );
    for (const entry of GOOGLE_ENDPOINT_CATALOG) {
      expect(entry.service.length).toBeGreaterThan(0);
    }
  });

  it('blocks the metadata server from day one and nothing else', () => {
    expect(
      GOOGLE_ENDPOINT_CATALOG.filter((e) => e.alwaysBlock)
        .map((e) => e.host)
        .sort(),
    ).toEqual(['169.254.169.254', 'metadata.google.internal']);
  });
});

describe('SDK_FINGERPRINT_HOSTS', () => {
  it('is exactly the set the throwing build check may grep for', () => {
    expect([...SDK_FINGERPRINT_HOSTS].sort()).toEqual([...EXPECTED_FINGERPRINT_HOSTS].sort());
  });

  it('excludes every host an app can carry without a Firebase SDK', () => {
    for (const host of EXPECTED_NON_FINGERPRINT_HOSTS) {
      expect(SDK_FINGERPRINT_HOSTS).not.toContain(host);
      expect(catalogHosts()).toContain(host);
    }
  });
});

describe('lookupGoogleEndpoint', () => {
  it('matches the narrowest suffix regardless of catalog order', () => {
    expect(lookupGoogleEndpoint('firebasestorage.googleapis.com')?.host).toBe(
      'firebasestorage.googleapis.com',
    );
    expect(lookupGoogleEndpoint('storage.googleapis.com')?.host).toBe('storage.googleapis.com');
  });

  it('matches subdomains on label boundaries', () => {
    expect(lookupGoogleEndpoint('us-central1-demo.cloudfunctions.net')?.host).toBe(
      'cloudfunctions.net',
    );
    expect(lookupGoogleEndpoint('demo-default-rtdb.firebasedatabase.app')?.host).toBe(
      'firebasedatabase.app',
    );
    expect(lookupGoogleEndpoint('evilfirebaseio.com')).toBeUndefined();
    expect(lookupGoogleEndpoint('example.com')).toBeUndefined();
  });

  it('normalizes case and a trailing root dot', () => {
    expect(lookupGoogleEndpoint('  FIRESTORE.googleapis.com. ')?.service).toBe('Cloud Firestore');
  });

  it('reports alwaysBlock for the metadata server', () => {
    expect(lookupGoogleEndpoint('169.254.169.254')?.alwaysBlock).toBe(true);
    expect(lookupGoogleEndpoint('metadata.google.internal')?.alwaysBlock).toBe(true);
  });
});

describe('the shared normalizer and suffix matcher', () => {
  it('normalizeHostname trims, lowercases and drops the root dot', () => {
    expect(normalizeHostname(' Example.COM. ')).toBe('example.com');
  });

  it('matchesHostSuffix respects label boundaries', () => {
    expect(matchesHostSuffix('example.com', 'example.com')).toBe(true);
    expect(matchesHostSuffix('a.example.com', 'example.com')).toBe(true);
    expect(matchesHostSuffix('notexample.com', 'example.com')).toBe(false);
  });
});

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

describe('normalizeHostname on IP literals', () => {
  /** Spellings of 169.254.169.254 the system resolver connects to (#1442). */
  const METADATA_SPELLINGS = [
    '2852039166',
    '0xa9fea9fe',
    '0XA9FEA9FE',
    '169.254.43518',
    '169.16689662',
    '0251.0376.0251.0376',
    '0xa9.0xfe.0xa9.0xfe',
    '169.254.169.254.',
    '::ffff:169.254.169.254',
    '::ffff:a9fe:a9fe',
    '[::ffff:a9fe:a9fe]',
    '0:0:0:0:0:ffff:a9fe:a9fe',
    '::FFFF:A9FE:A9FE',
    // An IPv6 zone id, which Node and the kernel accept and ignore here.
    '::ffff:a9fe:a9fe%lo',
    '::ffff:169.254.169.254%eth0',
    '[::ffff:a9fe:a9fe%25lo]',
    '[::ffff:a9fe:a9fe%lo]',
  ];

  it('writes every IPv4 spelling of the metadata IP as its dotted quad', () => {
    for (const spelling of METADATA_SPELLINGS) {
      expect({ spelling, host: normalizeHostname(spelling) }).toEqual({ spelling, host: '169.254.169.254' });
    }
  });

  it('finds the metadata server under every spelling', () => {
    for (const spelling of METADATA_SPELLINGS) {
      expect({ spelling, alwaysBlock: lookupGoogleEndpoint(spelling)?.alwaysBlock }).toEqual({
        spelling,
        alwaysBlock: true,
      });
    }
  });

  it('writes other IPv6 addresses in one compressed form without brackets', () => {
    expect(normalizeHostname('[::1]')).toBe('::1');
    expect(normalizeHostname('0:0:0:0:0:0:0:1')).toBe('::1');
    expect(normalizeHostname('2001:DB8::1')).toBe('2001:db8::1');
    expect(normalizeHostname('fe80::1%eth0')).toBe('fe80::1');
  });

  it('leaves hostnames, including ones made of hex digits, as text', () => {
    expect(normalizeHostname('cafe.bad')).toBe('cafe.bad');
    expect(normalizeHostname('deadbeef')).toBe('deadbeef');
    expect(normalizeHostname('127.0.0.1')).toBe('127.0.0.1');
    expect(normalizeHostname('localhost')).toBe('localhost');
  });

  it('leaves text the URL parser would read differently alone', () => {
    expect(normalizeHostname('2852039166/x')).toBe('2852039166/x');
    expect(normalizeHostname('a@2852039166')).toBe('a@2852039166');
  });
});

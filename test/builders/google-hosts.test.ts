import { describe, expect, test } from 'bun:test';
import { GOOGLE_HOST_SUFFIXES, classifyHost, isLoopbackHost, isRefusedHost } from './recorder/google-hosts.ts';

describe('classifyHost', () => {
  test('a host in pyric’s catalog is Google, with the catalog’s service, and no gap', () => {
    expect(classifyHost('firestore.googleapis.com')).toEqual({
      host: 'firestore.googleapis.com',
      google: true,
      service: 'Cloud Firestore',
      catalogGap: false,
      metadata: false,
    });
    expect(classifyHost('demo-x-default-rtdb.firebaseio.com')).toMatchObject({ google: true, service: 'Realtime Database', catalogGap: false });
  });

  test('a Google host the catalog does not list is a guard catalog gap (#1475)', () => {
    for (const host of ['oauth2.googleapis.com', 'firebaserules.googleapis.com', 'www.gstatic.com', 'demo-x.web.app', 'my-service-abc.a.run.app']) {
      expect(classifyHost(host)).toMatchObject({ host, google: true, catalogGap: true });
    }
  });

  test('every wider suffix is Google, as written and as a subdomain', () => {
    for (const suffix of GOOGLE_HOST_SUFFIXES) {
      expect(classifyHost(suffix).google).toBe(true);
      expect(classifyHost(`a.${suffix}`).google).toBe(true);
    }
  });

  test('the metadata server is flagged however its address is spelled', () => {
    for (const spelling of ['169.254.169.254', '2852039166', '0xa9fea9fe', '169.254.43518', '::ffff:169.254.169.254', '[::ffff:a9fe:a9fe]', 'METADATA.google.internal.']) {
      const verdict = classifyHost(spelling);
      expect(verdict.metadata).toBe(true);
      expect(verdict.google).toBe(true);
      expect(isRefusedHost(spelling)).toBe(true);
    }
  });

  test('a suffix matches on label boundaries only', () => {
    for (const host of ['notgoogleapis.com', 'googleapis.com.example', 'firebaseio.com.localhost', 'example.com', '127.0.0.1']) {
      expect(classifyHost(host)).toMatchObject({ google: false, catalogGap: false, metadata: false });
      expect(isRefusedHost(host)).toBe(false);
    }
  });

  test('hosts are compared in one spelling', () => {
    expect(classifyHost(' Firestore.GoogleAPIs.com. ').host).toBe('firestore.googleapis.com');
  });
});

describe('isLoopbackHost', () => {
  test('127.0.0.1, ::1 and localhost are loopback', () => {
    for (const host of ['127.0.0.1', 'localhost', '::1', '[::1]', 'app.localhost', '2130706433']) {
      expect(isLoopbackHost(host)).toBe(true);
    }
  });

  test('anything else is not', () => {
    for (const host of ['127.0.0.2', '169.254.169.254', 'localhost.example.com', 'firestore.googleapis.com']) {
      expect(isLoopbackHost(host)).toBe(false);
    }
  });
});

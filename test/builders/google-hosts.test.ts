import { describe, expect, test } from 'bun:test';
import { GOOGLE_HOST_SUFFIXES, classifyHost, isGoogleOrMetadata, isLoopbackHost, isRefusedHost } from './recorder/google-hosts.ts';

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

  test('Google’s analytics, tag, update, reCAPTCHA, PKI and video hosts are Google', () => {
    for (const host of ['region1.app-measurement.com', 'www.google-analytics.com', 'www.googletagmanager.com', 'redirector.gvt1.com', 'www.recaptcha.net', 'pki.goog', 'dns.google', 'www.youtube.com']) {
      expect(classifyHost(host)).toMatchObject({ host, google: true, catalogGap: true });
    }
  });

  test('Google’s country domains are Google, and look-alikes are not', () => {
    for (const host of ['google.de', 'www.google.co.uk', 'google.com.au', 'www.google.co.jp']) {
      expect(classifyHost(host)).toMatchObject({ google: true, catalogGap: true });
    }
    for (const host of ['notgoogle.de', 'google.example', 'google.de.example.com']) {
      expect(classifyHost(host).google).toBe(false);
    }
  });

  test('Google’s own addresses are Google, however they are spelled', () => {
    for (const spelling of ['8.8.8.8', '8.8.4.4', '142.250.1.1', '0x08080808', '::ffff:8.8.8.8', '2001:4860:4860::8888', '[2001:4860:4860::8844]', '2a00:1450:4001:80b::200e']) {
      expect(classifyHost(spelling)).toMatchObject({ google: true, catalogGap: true, metadata: false });
    }
  });

  test('addresses next to Google’s ranges are not Google', () => {
    for (const address of ['8.8.7.255', '8.8.9.0', '142.252.0.0', '1.1.1.1', '2001:4861::1', '2606:4700::1111', '::1']) {
      expect(classifyHost(address).google).toBe(false);
    }
  });

  test('hosts are compared in one spelling', () => {
    expect(classifyHost(' Firestore.GoogleAPIs.com. ').host).toBe('firestore.googleapis.com');
  });
});

describe('isGoogleOrMetadata', () => {
  test('is true for a Google host or the metadata server, and false without either flag', () => {
    expect(isGoogleOrMetadata({ google: true, metadata: false })).toBe(true);
    expect(isGoogleOrMetadata({ google: false, metadata: true })).toBe(true);
    expect(isGoogleOrMetadata({ google: false, metadata: false })).toBe(false);
    expect(isGoogleOrMetadata({})).toBe(false);
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

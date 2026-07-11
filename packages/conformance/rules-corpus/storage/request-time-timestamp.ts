/**
 * ─── Pack 3: request-time-timestamp ─────────────────────────────────────────
 * request.time compared against the timestamp constructors timestamp.date()
 * (UTC midnight) and timestamp.value() (epoch millis). #96/#104 mark time
 * unsupported.
 */
import type { StoragePackRecord } from './types.ts';

export const pack: StoragePackRecord = {
  fm: 'STORAGE-TIME',
  rationale:
    'request.time compared against timestamp.date(y,m,d) and timestamp.value(ms) — the time surface #96/#104 wrongly call unsupported.',
  rules: `rules_version = '2';
service firebase.storage {
  match /b/{bucket}/o {
    match /deadline/{fileId} {
      allow create: if request.time < timestamp.date(2030, 1, 1);
    }
    match /epoch/{fileId} {
      allow create: if request.time > timestamp.value(1000000000000);
    }
  }
}`,
  cases: [
    { description: 'timestamp.date(): before deadline allowed', expectation: 'ALLOW', method: 'create', path: 'deadline/a.txt', resource: { size: 10, contentType: 'text/plain' }, requestTime: '2025-06-01T00:00:00Z' },
    { description: 'timestamp.date(): after deadline denied', expectation: 'DENY', method: 'create', path: 'deadline/a.txt', resource: { size: 10, contentType: 'text/plain' }, requestTime: '2035-06-01T00:00:00Z' },
    { description: 'timestamp.value(): after epoch bound allowed', expectation: 'ALLOW', method: 'create', path: 'epoch/b.txt', resource: { size: 10, contentType: 'text/plain' }, requestTime: '2025-06-01T00:00:00Z' },
    { description: 'timestamp.value(): before epoch bound denied', expectation: 'DENY', method: 'create', path: 'epoch/b.txt', resource: { size: 10, contentType: 'text/plain' }, requestTime: '1990-01-01T00:00:00Z' },
  ],
};

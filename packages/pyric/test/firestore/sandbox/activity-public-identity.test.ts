import { describe, expect, it } from 'bun:test';
import {
  compactActivityFingerprint,
  createActivityPublicIdentity,
} from '../../../src/firestore/sandbox/activity-public-identity.js';

describe('activity public identity', () => {
  it('keeps public query identities stable and opaque within one monitor', () => {
    const identity = createActivityPublicIdentity(8);
    const queryA = 'users|query:{"value":{"digest":"known-a"}}';
    const queryB = 'users|query:{"value":{"digest":"known-b"}}';

    expect(identity.readTarget('users', queryA)).toMatch(/^users\|query:#\d+$/);
    expect(identity.readTarget('users', queryA)).toBe(identity.readTarget('users', queryA));
    expect(identity.readTarget('users', queryA)).not.toBe(identity.readTarget('users', queryB));
    expect(identity.readTarget('users', queryA)).not.toContain('known-a');

    expect(identity.incidentFingerprint('internal-a')).toMatch(/^activity:#\d+$/);
    expect(identity.incidentFingerprint('internal-a')).toBe(
      identity.incidentFingerprint('internal-a'),
    );
    expect(identity.incidentFingerprint('internal-a')).not.toBe(
      identity.incidentFingerprint('internal-b'),
    );
  });

  it('preserves listener collection context without exposing its query', () => {
    const identity = createActivityPublicIdentity(8);
    const target = JSON.stringify({
      kind: 'query',
      collection: 'users',
      query: { filters: [{ value: { digest: 'known-secret' } }] },
    });

    expect(identity.listenerTarget(target)).toMatch(
      /^\{"collection":"users","kind":"query","query":"#\d+"\}$/,
    );
    expect(identity.listenerTarget(target)).not.toContain('known-secret');
  });

  it('keeps document targets readable and clears retained identities', () => {
    const identity = createActivityPublicIdentity(8);
    expect(identity.readTarget('users/alice', 'users/alice')).toBe('users/alice');
    const before = identity.incidentFingerprint('same-key');
    identity.clear();
    expect(identity.incidentFingerprint('same-key')).not.toBe(before);
  });

  it('keeps malformed listener targets private', () => {
    const identity = createActivityPublicIdentity(8);
    expect(identity.listenerTarget('secret malformed target')).toMatch(
      /^\{"kind":"unknown","target":"#\d+"\}$/,
    );
    expect(identity.listenerTarget('secret malformed target')).not.toContain('secret');
  });

  it('bounds long public labels', () => {
    const compact = compactActivityFingerprint('x'.repeat(4_000));
    expect(compact.length).toBeLessThanOrEqual(1_800);
    expect(compact).toMatch(/…#[0-9a-f]{16}$/);
  });
});

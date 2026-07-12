/**
 * The worker's instance-id generator must NOT use `crypto.randomUUID()`
 * unguarded: that API is secure-context-only, so it is `undefined` over plain
 * http on a non-localhost host (a Tailscale or LAN hostname). Unguarded, the
 * worker throws on init there and the whole sandbox (auth, firestore, bridge)
 * never comes up. `randomUuid` falls back to `crypto.getRandomValues` (which is
 * NOT gated). Repro'd via the Tailscale e2e in test/e2e.
 */
import { describe, it, expect } from 'bun:test';
import { randomUuid } from '../../../src/serve/worker/host.js';

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

describe('randomUuid (secure-context-safe)', () => {
  it('returns a v4 UUID when crypto.randomUUID is available', () => {
    expect(randomUuid()).toMatch(UUID_V4);
  });

  it('falls back to getRandomValues when crypto.randomUUID is undefined (non-secure context)', () => {
    const orig = crypto.randomUUID;
    try {
      (crypto as { randomUUID?: unknown }).randomUUID = undefined;
      // Unguarded this would throw `crypto.randomUUID is not a function`.
      expect(randomUuid()).toMatch(UUID_V4);
    } finally {
      (crypto as { randomUUID?: unknown }).randomUUID = orig;
    }
  });
});

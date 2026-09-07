/**
 * The minted avatar URL, and which mint an init payload asks for.
 *
 * The URL shape is a one-way door (`docs/auth-avatars-design.md`): it is
 * written into persisted sandbox state, so a change here invalidates every
 * stored `photoURL`. The route's own parser is tested in `avatar-route.test.ts`
 * — these two files are the two halves of one contract.
 */
import { describe, expect, it } from 'bun:test';
import { avatarSeed, defaultAvatarDataUri } from 'pyric/auth/internal';

import {
  avatarAssetUrl,
  avatarMintForPayload,
  nullAvatarMint,
  servedAvatarMint,
} from '../../../src/serve/assets/avatar-url.js';
import { avatarUidFromPath } from '../../../src/serve/assets/avatar-route.js';

const ADA = {
  uid: 'google.com:ada@x.com',
  displayName: 'Ada',
  email: 'ada@x.com',
  providerId: 'google.com',
};

describe('avatarAssetUrl', () => {
  it('is a relative URL under the avatar route, seeded from the uid', () => {
    const url = new URL(avatarAssetUrl(ADA), 'http://localhost');
    expect(avatarAssetUrl(ADA).startsWith('/__pyric/assets/avatar/')).toBe(true);
    expect(url.pathname).toBe(`/__pyric/assets/avatar/${encodeURIComponent(ADA.uid)}`);
    expect(url.searchParams.get('d')).toBe(avatarSeed(ADA.uid));
  });

  it('carries the display name, email, and provider id as hints', () => {
    const url = new URL(avatarAssetUrl(ADA), 'http://localhost');
    expect(url.searchParams.get('n')).toBe('Ada');
    expect(url.searchParams.get('e')).toBe('ada@x.com');
    expect(url.searchParams.get('p')).toBe('google.com');
  });

  it('omits a hint the record does not carry rather than sending it empty', () => {
    const url = new URL(
      avatarAssetUrl({ ...ADA, displayName: null, email: null }),
      'http://localhost',
    );
    expect(url.searchParams.has('n')).toBe(false);
    expect(url.searchParams.has('e')).toBe(false);
    expect(url.searchParams.get('p')).toBe('google.com');
  });

  it('mints a path the route reads the same uid back out of', () => {
    const uids = ['google.com:ada@x.com', 'user with spaces', 'oidc.acme|abc#1'];
    for (const uid of uids) {
      const url = new URL(avatarAssetUrl({ ...ADA, uid }), 'http://localhost');
      expect(avatarUidFromPath(url.pathname)).toBe(uid);
    }
  });

  it('is deterministic — the same record always mints the same URL', () => {
    expect(avatarAssetUrl(ADA)).toBe(avatarAssetUrl(ADA));
  });
});

describe('avatarMintForPayload', () => {
  it('avatars: true asks for the served route mint', () => {
    expect(avatarMintForPayload(true)).toBe(servedAvatarMint);
    expect(avatarMintForPayload(true)!(ADA)).toBe(avatarAssetUrl(ADA));
  });

  it('avatars: false asks for the null mint (Firebase behaviour)', () => {
    expect(avatarMintForPayload(false)).toBe(nullAvatarMint);
    expect(avatarMintForPayload(false)!(ADA)).toBeNull();
  });

  it('an absent flag asks for nothing, leaving the built-in data-URI mint', () => {
    expect(avatarMintForPayload(undefined)).toBeNull();
  });

  it('the built-in mint the absent case leaves in place needs no route', () => {
    // Documents what "leave it alone" means: a data URI, resolvable offline.
    expect(defaultAvatarDataUri({ uid: ADA.uid, displayName: ADA.displayName, email: ADA.email })
      .startsWith('data:image/svg+xml,')).toBe(true);
  });
});

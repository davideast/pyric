/**
 * Unit tests for `absolutePhotoUrl`, `parseServedAvatarPhotoUrl`,
 * `portableAvatarPhotoUrl`, and `absoluteProviderPhotoUrls` (#581, #1244).
 */
import { describe, expect, it } from 'bun:test';
import {
  absolutePhotoUrl,
  absoluteProviderPhotoUrls,
  parseServedAvatarPhotoUrl,
  portableAvatarPhotoUrl,
} from '../../../src/sandbox/internal/photo-url.js';

const RELATIVE_AVATAR = '/__pyric/assets/avatar/ada?d=0123456789abcdef&p=google.com';
const ORIGIN = 'http://localhost:5173';

describe('photo-url helpers', () => {
  it('resolves root-relative avatar paths against http(s) origins and preserves other URLs', () => {
    expect(absolutePhotoUrl(RELATIVE_AVATAR, ORIGIN)).toBe(`${ORIGIN}${RELATIVE_AVATAR}`);
    expect(absolutePhotoUrl(RELATIVE_AVATAR, null)).toBe(RELATIVE_AVATAR);
    expect(absolutePhotoUrl(RELATIVE_AVATAR, 'blob:null/123')).toBe(RELATIVE_AVATAR);
    expect(absolutePhotoUrl('//cdn.example.com/a.png', ORIGIN)).toBe('//cdn.example.com/a.png');
    expect(absolutePhotoUrl('https://cdn.example.com/a.png', ORIGIN)).toBe('https://cdn.example.com/a.png');
    expect(absolutePhotoUrl(null, ORIGIN)).toBeNull();
  });

  it('parses relative and absolute served avatar URLs back to their portable path and origin', () => {
    expect(parseServedAvatarPhotoUrl(RELATIVE_AVATAR)).toEqual({
      relativePath: RELATIVE_AVATAR,
      origin: null,
    });
    expect(parseServedAvatarPhotoUrl(`${ORIGIN}${RELATIVE_AVATAR}`)).toEqual({
      relativePath: RELATIVE_AVATAR,
      origin: ORIGIN,
    });
    expect(parseServedAvatarPhotoUrl('https://cdn.example.com/avatars/ada.png')).toBeNull();
    expect(parseServedAvatarPhotoUrl('http://localhost:5173/other/__pyric/assets/avatar/ada')).toBeNull();
    expect(parseServedAvatarPhotoUrl(null)).toBeNull();
  });

  it('strips host origin from served avatar URLs while leaving external and data URLs intact', () => {
    expect(portableAvatarPhotoUrl(`${ORIGIN}${RELATIVE_AVATAR}`)).toBe(RELATIVE_AVATAR);
    expect(portableAvatarPhotoUrl(RELATIVE_AVATAR)).toBe(RELATIVE_AVATAR);
    expect(portableAvatarPhotoUrl('https://cdn.example.com/avatars/ada.png')).toBe(
      'https://cdn.example.com/avatars/ada.png',
    );
    expect(portableAvatarPhotoUrl('data:image/svg+xml;utf8,<svg/>')).toBe(
      'data:image/svg+xml;utf8,<svg/>',
    );
    expect(portableAvatarPhotoUrl(null)).toBeNull();
  });

  it('resolves relative photoURL values across providerData entries', () => {
    const entries = [
      { providerId: 'google.com', uid: 'ada', photoURL: RELATIVE_AVATAR },
      { providerId: 'github.com', uid: 'ada', photoURL: 'https://avatars.example/ada.png' },
      { providerId: 'password', uid: 'ada@example.com', photoURL: null },
    ];
    const resolved = absoluteProviderPhotoUrls(entries, ORIGIN);
    expect(resolved).toEqual([
      { providerId: 'google.com', uid: 'ada', photoURL: `${ORIGIN}${RELATIVE_AVATAR}` },
      { providerId: 'github.com', uid: 'ada', photoURL: 'https://avatars.example/ada.png' },
      { providerId: 'password', uid: 'ada@example.com', photoURL: null },
    ]);
  });
});

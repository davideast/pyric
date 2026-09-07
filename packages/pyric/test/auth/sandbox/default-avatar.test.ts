import { describe, expect, it } from 'bun:test';
import {
  avatarSeed,
  defaultAvatarDataUri,
  defaultAvatarSvg,
} from '../../../src/auth/sandbox/default-avatar.js';

describe('avatarSeed', () => {
  it('is 16 lowercase hex chars', () => {
    const seed = avatarSeed('google-abc123');
    expect(seed).toMatch(/^[0-9a-f]{16}$/);
  });

  it('is deterministic for the same uid', () => {
    expect(avatarSeed('google-abc123')).toBe(avatarSeed('google-abc123'));
  });
});

describe('defaultAvatarDataUri', () => {
  it('is deterministic for the same input', () => {
    const input = { uid: 'google-abc123', displayName: 'Ada Lovelace' };
    expect(defaultAvatarDataUri(input)).toBe(defaultAvatarDataUri(input));
  });

  it('produces distinct output for distinct uids', () => {
    const outputs = new Set<string>();
    for (let i = 0; i < 20; i++) {
      outputs.add(defaultAvatarDataUri({ uid: `uid-${i}` }));
    }
    expect(outputs.size).toBe(20);
  });

  it('starts with the data:image/svg+xml, prefix', () => {
    const uri = defaultAvatarDataUri({ uid: 'google-abc123' });
    expect(uri.startsWith('data:image/svg+xml,')).toBe(true);
  });

  it('prefers displayName over email for the glyph', () => {
    const uri = defaultAvatarDataUri({
      uid: 'u1',
      displayName: 'Ada Lovelace',
      email: 'zoe@example.com',
    });
    const svg = decodeURIComponent(uri.slice('data:image/svg+xml,'.length));
    expect(svg).toContain('>A<');
  });

  it('falls back to the email local part when displayName is absent', () => {
    const uri = defaultAvatarDataUri({ uid: 'u2', email: 'zoe@example.com' });
    const svg = decodeURIComponent(uri.slice('data:image/svg+xml,'.length));
    expect(svg).toContain('>Z<');
  });

  it('renders no glyph when neither displayName nor email is present', () => {
    const uri = defaultAvatarDataUri({ uid: 'u3' });
    const svg = decodeURIComponent(uri.slice('data:image/svg+xml,'.length));
    expect(svg).not.toContain('<text');
  });

  it('handles a multi-byte first character (emoji) with a well-formed URI', () => {
    const uri = defaultAvatarDataUri({ uid: 'u4', displayName: '🔥Blaze' });
    expect(() => decodeURIComponent(uri.slice('data:image/svg+xml,'.length))).not.toThrow();
    const svg = decodeURIComponent(uri.slice('data:image/svg+xml,'.length));
    expect(svg).toContain('<svg');
    expect(svg).toContain('🔥');
  });

  it('stays under 1000 bytes for a typical input', () => {
    const uri = defaultAvatarDataUri({ uid: 'google-abc123', displayName: 'Ada Lovelace' });
    expect(new TextEncoder().encode(uri).length).toBeLessThan(1000);
  });

  it('stays under 1000 bytes for an emoji input', () => {
    const uri = defaultAvatarDataUri({ uid: 'u5', displayName: '🔥Blaze' });
    expect(new TextEncoder().encode(uri).length).toBeLessThan(1000);
  });
});

describe('defaultAvatarSvg', () => {
  it('is the raw SVG markup the data URI encodes', () => {
    const input = { uid: 'google-abc123', displayName: 'Ada Lovelace' };
    const svg = defaultAvatarSvg(input);
    expect(svg.startsWith('<svg')).toBe(true);
    expect(defaultAvatarDataUri(input)).toBe(`data:image/svg+xml,${encodeURIComponent(svg).replace(/'/g, '%27').replace(/\(/g, '%28').replace(/\)/g, '%29')}`);
  });

  it('renders a visibly distinct generating state when pending', () => {
    const input = { uid: 'google-abc123', displayName: 'Ada Lovelace' };
    const settled = defaultAvatarSvg(input);
    const pending = defaultAvatarSvg({ ...input, pending: true });

    // Same identity artwork, so the face does not change on upgrade.
    expect(pending).toContain('<linearGradient');
    expect(pending).toContain('>A</text>');
    // ...but it must not be mistakable for a finished image.
    expect(pending).not.toBe(settled);
    expect(settled).not.toContain('animateTransform');
    expect(pending).toContain('animateTransform');
    expect(pending).toContain('repeatCount="indefinite"');
    expect(pending).toContain('fill-opacity="0.55"'); // initial dimmed
  });

  it('keeps the pending ring inside the radius a circular crop cuts at', () => {
    const pending = defaultAvatarSvg({ uid: 'u', displayName: 'Zed', pending: true });
    // r=56 plus half of a 6-wide stroke reaches 59, inside the 64 radius.
    expect(pending).toContain('r="56"');
    expect(pending).toContain('stroke-width="6"');
  });

  it('is deterministic in the pending state too', () => {
    const input = { uid: 'google-abc123', displayName: 'Ada Lovelace', pending: true };
    expect(defaultAvatarSvg(input)).toBe(defaultAvatarSvg(input));
  });

  it('never animates the settled avatar the data URI mint produces', () => {
    // In-page mode has no source and therefore no generating state.
    expect(defaultAvatarDataUri({ uid: 'u', displayName: 'Ada' })).not.toContain('animateTransform');
  });
});

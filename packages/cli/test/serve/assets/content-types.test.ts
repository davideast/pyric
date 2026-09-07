import { describe, expect, it } from 'bun:test';
import { contentTypeFor, extensionFor } from '../../../src/serve/assets/content-types.js';

describe('extensionFor', () => {
  it('maps exactly the four known image content types', () => {
    expect(extensionFor('image/png')).toBe('png');
    expect(extensionFor('image/jpeg')).toBe('jpg');
    expect(extensionFor('image/svg+xml')).toBe('svg');
    expect(extensionFor('image/webp')).toBe('webp');
  });

  it('returns null for anything else', () => {
    expect(extensionFor('image/gif')).toBeNull();
    expect(extensionFor('application/json')).toBeNull();
    expect(extensionFor('')).toBeNull();
  });
});

describe('contentTypeFor', () => {
  it('maps known extensions back to their content type', () => {
    expect(contentTypeFor('a.png')).toBe('image/png');
    expect(contentTypeFor('a.jpg')).toBe('image/jpeg');
    expect(contentTypeFor('a.jpeg')).toBe('image/jpeg');
    expect(contentTypeFor('a.svg')).toBe('image/svg+xml');
    expect(contentTypeFor('a.webp')).toBe('image/webp');
  });

  it('returns null for an unknown or absent extension', () => {
    expect(contentTypeFor('a.gif')).toBeNull();
    expect(contentTypeFor('noext')).toBeNull();
    expect(contentTypeFor('trailing.')).toBeNull();
  });
});

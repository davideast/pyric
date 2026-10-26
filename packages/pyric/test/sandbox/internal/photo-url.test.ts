import { describe, expect, it } from 'bun:test';

import { absolutePhotoUrl } from '../../../src/sandbox/internal/photo-url.js';

describe('absolutePhotoUrl', () => {
  it('resolves a relative photo URL against the page origin', () => {
    expect(absolutePhotoUrl('/__pyric/assets/avatar/u1?d=ab&p=google.com', 'http://localhost:5173'))
      .toBe('http://localhost:5173/__pyric/assets/avatar/u1?d=ab&p=google.com');
  });

  it('leaves an absolute photo URL unchanged', () => {
    expect(absolutePhotoUrl('https://lh3.googleusercontent.com/a/photo.png', 'http://localhost:5173'))
      .toBe('https://lh3.googleusercontent.com/a/photo.png');
    expect(absolutePhotoUrl('data:image/svg+xml,%3Csvg%3E', 'http://localhost:5173'))
      .toBe('data:image/svg+xml,%3Csvg%3E');
  });

  it('leaves a relative photo URL relative when no origin is known', () => {
    expect(absolutePhotoUrl('/__pyric/assets/avatar/u1?d=ab', null)).toBe('/__pyric/assets/avatar/u1?d=ab');
    expect(absolutePhotoUrl('/__pyric/assets/avatar/u1?d=ab', undefined)).toBe('/__pyric/assets/avatar/u1?d=ab');
  });

  it('keeps a missing photo missing', () => {
    expect(absolutePhotoUrl(null, 'http://localhost:5173')).toBeNull();
  });

  it('ignores an origin that is not an http(s) origin', () => {
    expect(absolutePhotoUrl('/__pyric/assets/avatar/u1', 'null')).toBe('/__pyric/assets/avatar/u1');
  });
});

import { describe, expect, it } from 'bun:test';
import { playgroundEmbedSrc } from './PlaygroundSurface.js';

describe('PlaygroundSurface', () => {
  it('starts embedded Studio on the playground app home route', () => {
    expect(playgroundEmbedSrc('/__pyric/playground/', 'https://studio.local')).toBe(
      '/__pyric/playground/?embed=studio',
    );
  });

  it('preserves absolute override origins for development', () => {
    expect(playgroundEmbedSrc('http://127.0.0.1:4322/', 'https://studio.local')).toBe(
      'http://127.0.0.1:4322/?embed=studio',
    );
  });
});

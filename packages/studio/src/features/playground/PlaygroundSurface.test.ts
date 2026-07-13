import { describe, expect, it } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { PlaygroundSurface, playgroundEmbedSrc } from './PlaygroundSurface.js';

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

  it('renders exactly one Playground frame at the embedded route', () => {
    const priorWindow = globalThis.window;
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: { location: { origin: 'https://studio.local' } },
    });
    try {
      const html = renderToStaticMarkup(
        createElement(PlaygroundSurface, { onNavigateSettings: () => {} }),
      );
      expect(html.match(/<iframe\b/g)).toHaveLength(1);
      expect(html).toContain('src="/__pyric/playground/?embed=studio"');
    } finally {
      Object.defineProperty(globalThis, 'window', {
        configurable: true,
        value: priorWindow,
      });
    }
  });
});

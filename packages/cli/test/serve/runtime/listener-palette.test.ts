import { describe, expect, it } from 'bun:test';
import {
  listenerColors,
  listenerHue,
  listenerHueIndex,
  listenerPalette,
} from '../../../src/serve/runtime/listener-palette.js';

describe('the listener palette', () => {
  it('gives one listener id the same hue every time', () => {
    expect(listenerHue('sub-7')).toBe(listenerHue('sub-7'));
    expect(listenerHueIndex('sub-7')).toBe(listenerHueIndex('sub-7'));
  });

  it('keeps every index inside the palette', () => {
    const palette = listenerPalette();
    for (let i = 0; i < 200; i += 1) {
      const index = listenerHueIndex(`sub-${i}`);
      expect(index).toBeGreaterThanOrEqual(0);
      expect(index).toBeLessThan(palette.length);
      expect(palette).toContain(listenerHue(`sub-${i}`));
    }
  });

  it('spreads consecutive subscription ids over every hue', () => {
    const used = new Set<number>();
    for (let i = 0; i < 40; i += 1) used.add(listenerHueIndex(`sub-${i}`));
    expect(used.size).toBe(listenerPalette().length);
  });

  it('separates the first few listeners a page attaches', () => {
    const ids = ['sub-1', 'sub-2', 'sub-3', 'sub-4'];
    const hues = new Set(ids.map(listenerHue));
    expect(hues.size).toBe(ids.length);
  });

  it('builds every colour a painter needs from one hue', () => {
    const colors = listenerColors('sub-1');
    const hue = listenerHue('sub-1');
    expect(colors.border).toContain(String(hue));
    expect(colors.fill).toContain(String(hue));
    expect(colors.accent).toContain(String(hue));
    expect(colors.swatch).toBe(colors.border);
  });

  it('gives different ids different colours when their hues differ', () => {
    const a = listenerColors('sub-1');
    const b = listenerColors('sub-2');
    expect(a.border).not.toBe(b.border);
  });
});

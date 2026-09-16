import { describe, expect, it } from 'bun:test';
import type { UserConfig } from 'vite';
import { pyric } from '../../src/serve/vite-plugin.js';

describe('Vite plugin', () => {
  it('keeps production builds on Firebase when hosted development is enabled', () => {
    const plugin = pyric({ hosted: true });
    const applies = plugin.apply;
    const hasNoApplyHook = typeof applies !== 'function';
    if (hasNoApplyHook) throw new Error('The plugin has no apply hook');
    expect(applies({}, { command: 'build', mode: 'production' })).toBe(false);
    expect(applies({}, { command: 'serve', mode: 'development' })).toBe(true);
  });

  it('configures server watch ignores for pyric runtime directory', () => {
    const plugin = pyric();
    if (!plugin.config) {
      throw new Error('pyric() plugin did not return a config hook');
    }
    const configHook = typeof plugin.config === 'function' ? plugin.config : plugin.config.handler;
    const result = configHook({}, { command: 'serve', mode: 'development' }) as UserConfig;
    expect(result.server?.watch?.ignored).toContain('**/.pyric/**');
  });
});

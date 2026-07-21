import { describe, expect, it } from 'bun:test';
import { pyric } from '../../src/serve/vite-plugin.js';

type PyricPlugin = ReturnType<typeof pyric>;

function transform(plugin: PyricPlugin): string {
  return (plugin.transformIndexHtml as (html: string) => string)(
    '<html><head></head><body></body></html>',
  );
}

describe('pyric() runtime chip injection', () => {
  it('injects the collapsed chip configuration by default before the init module', () => {
    const html = transform(pyric());
    const meta = 'name="pyric-runtime-chip" content="collapsed"';

    expect(html).toContain(meta);
    expect(html.indexOf(meta)).toBeLessThan(html.indexOf('/@fs/'));
  });

  it('supports the opt-out and initially-open configuration without another plugin', () => {
    expect(transform(pyric({ runtimeChip: false }))).toContain(
      'name="pyric-runtime-chip" content="off"',
    );
    expect(transform(pyric({ runtimeChip: { initiallyOpen: true } }))).toContain(
      'name="pyric-runtime-chip" content="expanded"',
    );
  });

  it('disables the stable Studio action when the Vite Studio mount is off', () => {
    expect(transform(pyric({ ui: false }))).toContain('data-studio="off"');
  });

  it('carries the same configuration into sandbox builds only when the plugin applies', () => {
    const plugin = pyric();
    const applies = plugin.apply as (
      config: unknown,
      env: { command: 'build'; mode: string },
    ) => boolean;
    expect(applies({}, { command: 'build', mode: 'production' })).toBe(false);
    expect(applies({}, { command: 'build', mode: 'development' })).toBe(true);

    (plugin.config as (config: unknown, env: unknown) => unknown)(
      {},
      { command: 'build', mode: 'development' },
    );
    const html = transform(plugin);
    expect(html).toContain('data-pyric-sandbox-build');
    expect(html).toContain('name="pyric-runtime-chip" content="collapsed"');
  });
});

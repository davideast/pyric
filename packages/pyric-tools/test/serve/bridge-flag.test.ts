/**
 * `--ui` implies `--bridge` (hybrid-MCP plan Phase 3): a Studio user almost
 * always wants MCP too, and the two independent flags were the setup footgun.
 */
import { describe, it, expect } from 'bun:test';
import { bridgeEnabledFromFlags } from '../../src/cli/serve.js';

const flags = (o: Record<string, unknown>) => new Map(Object.entries(o));

describe('bridgeEnabledFromFlags', () => {
  it('is true with --bridge', () => {
    expect(bridgeEnabledFromFlags(flags({ bridge: true }))).toBe(true);
  });

  it('is true with --ui alone (implies --bridge)', () => {
    expect(bridgeEnabledFromFlags(flags({ ui: true }))).toBe(true);
  });

  it('is true with both', () => {
    expect(bridgeEnabledFromFlags(flags({ bridge: true, ui: true }))).toBe(true);
  });

  it('is false with neither', () => {
    expect(bridgeEnabledFromFlags(flags({ port: '5000' }))).toBe(false);
  });
});

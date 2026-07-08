/**
 * `--ui` implies `--bridge` (hybrid-MCP plan Phase 3): a Studio user almost
 * always wants MCP too, and the two independent flags were the setup footgun.
 */
import { describe, it, expect } from 'bun:test';
import { bridgeEnabledFor, bridgeEnabledFromFlags } from '../../src/cli/serve.js';

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

describe('bridgeEnabledFor (child implies bridge)', () => {
  it('a planned dev child turns the bridge on without flags', () => {
    expect(bridgeEnabledFor(flags({}), { label: 'node server.mjs' })).toBe(true);
  });
  it('no child and no flags leaves the bridge off', () => {
    expect(bridgeEnabledFor(flags({}), null)).toBe(false);
  });
  it('flags still win independently of a child', () => {
    expect(bridgeEnabledFor(flags({ bridge: true }), null)).toBe(true);
    expect(bridgeEnabledFor(flags({ ui: true }), null)).toBe(true);
  });
});

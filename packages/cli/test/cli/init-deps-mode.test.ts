/** `pyric init` deps-mode resolution + dependency rewriting.
 *
 *  Pure-function coverage for the vendor/npm split (init.ts): which mode wins
 *  given flags/env/standalone, and how `pyric` / `@pyric/cli` deps are
 *  rewritten in each. No binary, no tarballs — the real `bun install` proof
 *  lives in scripts/standalone-vendor-smoke against a compiled binary. */
import { describe, expect, it } from 'bun:test';
import { applyDepsMode, resolveDepsMode } from '../../src/cli/init.js';
import { TEMPLATES } from '../../src/cli/init-templates.js';
import type { ParsedArgs } from '../../src/cli/parse-args.js';

const args = (flags: Record<string, string | boolean> = {}): ParsedArgs => ({
  subcommand: null,
  flags: new Map(Object.entries(flags)),
  positional: [],
});

describe('resolveDepsMode', () => {
  it('honors an explicit --deps flag', () => {
    expect(resolveDepsMode(args({ deps: 'vendor' }))).toBe('vendor');
    expect(resolveDepsMode(args({ deps: 'npm' }))).toBe('npm');
  });

  it('falls back to PYRIC_INIT_DEPS, then to npm when not standalone', () => {
    expect(resolveDepsMode(args(), { PYRIC_INIT_DEPS: 'vendor' })).toBe('vendor');
    expect(resolveDepsMode(args(), {})).toBe('npm'); // no global → not standalone
  });

  it('flag beats env', () => {
    expect(resolveDepsMode(args({ deps: 'npm' }), { PYRIC_INIT_DEPS: 'vendor' })).toBe('npm');
  });
});

describe('applyDepsMode — vendor', () => {
  const specs = { pyric: 'file:vendor/pyric.tgz', '@pyric/cli': 'file:vendor/pyric-cli.tgz' };

  it('web template: rewrites @pyric/cli and ADDS pyric (needed transitively)', () => {
    const out = applyDepsMode(TEMPLATES.web, 'vendor', { vendorSpecs: specs });
    expect(out.devDependencies['@pyric/cli']).toBe('file:vendor/pyric-cli.tgz');
    expect(out.devDependencies['pyric']).toBe('file:vendor/pyric.tgz');
    // unrelated deps untouched
    expect(out.dependencies['firebase']).toBe(TEMPLATES.web.dependencies['firebase']);
    expect(out.devDependencies['vite']).toBe(TEMPLATES.web.devDependencies['vite']);
    // pins pyric via overrides so a transitive pyric@* can't pull the published stub
    expect(out.overrides).toEqual({ pyric: 'file:vendor/pyric.tgz' });
  });

  it('node template: vendors the dev-only swap packages while Firebase stays a runtime dependency', () => {
    const out = applyDepsMode(TEMPLATES.node, 'vendor', { vendorSpecs: specs });
    expect(out.dependencies['firebase']).toBe(TEMPLATES.node.dependencies['firebase']);
    expect(out.devDependencies['pyric']).toBe('file:vendor/pyric.tgz');
    expect(out.devDependencies['@pyric/cli']).toBe('file:vendor/pyric-cli.tgz');
  });

  it('does not mutate the shared template object', () => {
    const before = JSON.stringify(TEMPLATES.web.devDependencies);
    applyDepsMode(TEMPLATES.web, 'vendor', { vendorSpecs: specs });
    expect(JSON.stringify(TEMPLATES.web.devDependencies)).toBe(before);
  });
});

describe('applyDepsMode — npm', () => {
  it('pins to ^version when given, never adds pyric or overrides to the web template', () => {
    const out = applyDepsMode(TEMPLATES.web, 'npm', { version: '0.1.2' });
    expect(out.devDependencies['@pyric/cli']).toBe('^0.1.2');
    expect('pyric' in out.devDependencies).toBe(false); // npm resolves it transitively
    expect(out.overrides).toBeUndefined();
  });

  it('keeps the template range when no version is available', () => {
    const out = applyDepsMode(TEMPLATES.web, 'npm', { version: null });
    expect(out.devDependencies['@pyric/cli']).toBe(TEMPLATES.web.devDependencies['@pyric/cli']);
  });
});

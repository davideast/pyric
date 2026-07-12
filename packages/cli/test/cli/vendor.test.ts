/**
 * `pyric vendor` — retrofit the vendored pyric/@pyric/cli into any existing
 * project. The happy path lays embedded tarballs (standalone-binary only), so the
 * unit coverage is the dep-injection (the heart of it) + the non-standalone guard.
 */
import { describe, it, expect } from 'bun:test';
import {
  VENDOR_TEMPLATE,
  applyDepsMode,
  mergeIntoExistingPackageJson,
  runVendor,
} from '../../src/cli/init.js';

const SPECS = {
  pyric: 'file:vendor/pyric-0.1.0.tgz',
  '@pyric/cli': 'file:vendor/pyric-cli-0.1.0.tgz',
};

describe('pyric vendor: dep injection', () => {
  it('merges pyric + @pyric/cli file: deps into an existing package.json, preserving the rest', () => {
    const effective = applyDepsMode(VENDOR_TEMPLATE, 'vendor', { vendorSpecs: SPECS });
    const existing = JSON.stringify(
      { name: 'my-app', dependencies: { firebase: '^10.0.0' }, scripts: { dev: 'vite' } },
      null,
      2,
    );
    const merge = mergeIntoExistingPackageJson(existing, 'my-app', effective);
    const pkg = JSON.parse(merge.contents);

    // Vendored deps land as file: refs; the pyric override pins the transitive dep.
    expect(pkg.devDependencies['@pyric/cli']).toBe(SPECS['@pyric/cli']);
    expect(pkg.devDependencies.pyric).toBe(SPECS.pyric);
    expect(pkg.overrides.pyric).toBe(SPECS.pyric);
    // The project's own deps + scripts are untouched.
    expect(pkg.dependencies.firebase).toBe('^10.0.0');
    expect(pkg.scripts.dev).toBe('vite');
    expect(merge.conflicts).toEqual([]);
  });

  it('is idempotent: a second merge reports unchanged', () => {
    const effective = applyDepsMode(VENDOR_TEMPLATE, 'vendor', { vendorSpecs: SPECS });
    const once = mergeIntoExistingPackageJson(JSON.stringify({ name: 'app' }), 'app', effective);
    const twice = mergeIntoExistingPackageJson(once.contents, 'app', effective);
    expect(twice.unchanged).toBe(true);
  });
});

describe('pyric vendor: guard', () => {
  it('errors (exit 1) outside the standalone binary — nothing to vendor', async () => {
    let errText = '';
    const code = await runVendor({ flags: new Map(), positional: [] } as never, {
      stderr: { write: (s) => { errText += s; } },
    });
    expect(code).toBe(1);
    expect(errText).toContain('standalone binary');
  });
});

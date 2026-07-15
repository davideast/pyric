import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';

const manifest = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
) as { exports: Record<string, unknown> };
const rootManifest = JSON.parse(
  readFileSync(new URL('../../../package.json', import.meta.url), 'utf8'),
) as { scripts: Record<string, string> };
const manifestWithScripts = manifest as typeof manifest & { scripts: Record<string, string> };

describe('@pyric/cli package manifest', () => {
  it('does not publish retired programmatic entry points', () => {
    expect(Object.keys(manifest.exports)).not.toContain('./deploy');
    expect(Object.keys(manifest.exports)).not.toContain('./credentials');
    expect(Object.keys(manifest.exports)).not.toContain('./auth');
    expect(Object.keys(manifest.exports)).not.toContain('./registry');
  });

  it('isolates production discovery from the credential-free entry', () => {
    expect(Object.keys(manifest.exports)).toContain('./discover');
    expect(Object.keys(manifest.exports)).not.toContain('./discover/production');
  });

  it('generates ignored conformance modules before clean-checkout test and typecheck commands', () => {
    expect(rootManifest.scripts.pretest).toContain('build.sh --packages-only');
    expect(rootManifest.scripts['pretest:ci:cli']).toContain('compat:conformance');
    expect(manifestWithScripts.scripts.pretest).toContain('build.sh --packages-only');
    expect(manifestWithScripts.scripts.pretypecheck).toContain('build.sh --packages-only');
  });

  it('publishes a separate compact browser conformance entry', () => {
    expect(Object.keys(manifest.exports)).toContain('./conformance');
    expect(Object.keys(manifest.exports)).toContain('./conformance/browser');
  });
});

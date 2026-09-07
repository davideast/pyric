import { describe, expect, test } from 'bun:test';
import { requiresPackagingProof, selectPrCheckSet, type ChangedPath } from './check-set.ts';

const changed = (path: string, previousPath?: string): ChangedPath => ({ path, previousPath });

describe('PR check-set selection', () => {
  test('uses the release proof only when every changed path has a release contract', () => {
    expect(selectPrCheckSet({
      event: 'pull_request',
      labels: [],
      paths: [changed('scripts/publish-alpha.sh')],
    })).toBe('release-only');
  });

  test('uses the docs proof only for authored Markdown content and internal repo docs', () => {
    expect(selectPrCheckSet({
      event: 'pull_request',
      labels: [],
      paths: [changed('packages/site-docs/src/content/get-started.md')],
    })).toBe('docs-only');
    expect(selectPrCheckSet({
      event: 'pull_request',
      labels: [],
      paths: [changed('PRIORITIES.md')],
    })).toBe('docs-only');
    expect(selectPrCheckSet({
      event: 'pull_request',
      labels: [],
      paths: [changed('CONTEXT.md'), changed('AGENTS.md')],
    })).toBe('docs-only');
    expect(selectPrCheckSet({
      event: 'pull_request',
      labels: [],
      paths: [changed('.github/pull_request_template.md')],
    })).toBe('docs-only');
  });

  test.each([
    ['mixed release and docs', [changed('scripts/publish-alpha.sh'), changed('packages/site-docs/src/content/get-started.md')]],
    ['non-Markdown docs file', [changed('packages/site-docs/src/content/component.ts')]],
    ['published README', [changed('README.md')]],
    ['untested release wrapper', [changed('scripts/prepare-release.sh')]],
    ['unknown file', [changed('new-area/config.txt')]],
    ['rename into an exemption', [changed('scripts/publish-alpha.sh', 'scripts/old-publisher.sh')]],
  ])('falls back to full CI for %s', (_name, paths) => {
    expect(selectPrCheckSet({ event: 'pull_request', labels: [], paths })).toBe('full');
  });

  test('full-proof labels and non-PR events always select full CI', () => {
    const paths = [changed('scripts/publish-alpha.sh')];
    expect(selectPrCheckSet({ event: 'pull_request', labels: ['ci-full'], paths })).toBe('full');
    expect(selectPrCheckSet({ event: 'pull_request', labels: ['ci-packaging'], paths })).toBe('full');
    expect(selectPrCheckSet({ event: 'push', labels: [], paths })).toBe('full');
  });

  test('adding any non-exempt path revokes an exemption', () => {
    const exemptSets: ChangedPath[][] = [
      [changed('scripts/publish-alpha.sh')],
      [changed('packages/site-docs/src/content/overview.md')],
    ];
    for (const paths of exemptSets) {
      expect(selectPrCheckSet({
        event: 'pull_request',
        labels: [],
        paths: [...paths, changed('package.json')],
      })).toBe('full');
    }
  });
});

describe('packaging proof selection', () => {
  test('a scaffolder change requires it, with no label', () => {
    // The case that shipped broken: #580 edited the scaffolded vite config and
    // the packaging gate, which asserts that file's shape, never ran.
    expect(requiresPackagingProof([changed('packages/create-pyric/src/templates.ts')])).toBe(true);
  });

  test('a published package manifest requires it', () => {
    expect(requiresPackagingProof([changed('packages/cli/package.json')])).toBe(true);
    expect(requiresPackagingProof([changed('packages/pyric/package.json')])).toBe(true);
  });

  test('the packaging scripts themselves require it', () => {
    for (const path of [
      'scripts/packaging-test.sh',
      'scripts/install-matrix.sh',
      'scripts/lib/package-artifact-manifest.ts',
    ]) {
      expect(requiresPackagingProof([changed(path)])).toBe(true);
    }
  });

  test('ordinary source and doc changes do not', () => {
    expect(requiresPackagingProof([
      changed('packages/cli/src/serve/namespace.ts'),
      changed('packages/site-docs/src/content/overview.md'),
      changed('package.json'),
    ])).toBe(false);
  });

  test('a rename counts on either side', () => {
    expect(requiresPackagingProof([
      changed('packages/cli/src/moved.ts', 'packages/create-pyric/src/templates.ts'),
    ])).toBe(true);
  });

  test('one qualifying path among many is enough', () => {
    expect(requiresPackagingProof([
      changed('README.md'),
      changed('packages/create-pyric/src/templates.ts'),
    ])).toBe(true);
  });
});

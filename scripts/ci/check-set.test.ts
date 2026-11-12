import { describe, expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  requiresPackagingProof,
  RULES_ONLY_PROOF,
  selectPrCheckSet,
  selectShadowCheckSet,
  type ChangedPath,
  type CheckSetInput,
  type PrCheckSet,
} from './check-set.ts';

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

  test('a merge group selects full CI even when every path would take a fast path', () => {
    for (const path of ['scripts/publish-alpha.sh', 'PRIORITIES.md']) {
      expect(selectPrCheckSet({ event: 'merge_group', labels: [], paths: [changed(path)] })).toBe('full');
    }
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

describe('rules-only shadow selection', () => {
  const pr = (paths: ChangedPath[], labels: string[] = []): CheckSetInput => ({ event: 'pull_request', labels, paths });
  const rulesOnlySets: Array<[string, ChangedPath[]]> = [
    ['rules engine source', [changed('packages/rules/src/simulator/evaluation-builtins.ts')]],
    ['rules package tests and manifest', [changed('packages/rules/test/simulator/lookup-path.test.ts'), changed('packages/rules/package.json')]],
    ['rules-language snapshot', [changed('packages/conformance/rules-language/firestore.json')]],
    ['rules corpus case', [changed('packages/conformance/rules-corpus/firestore/astral-range-matches.ts')]],
    ['rules observations', [
      changed('packages/conformance/observations/firestore-rules/rules-firestore-astral-range-matches.json'),
      changed('packages/conformance/observations/storage-rules/x.json'),
      changed('packages/conformance/observations/rtdb-rules/x.json'),
    ]],
    ['Storage rules exception and scorecard baselines', [
      changed('packages/conformance/storage-rules-exceptions/x.json'),
      changed('packages/conformance/baselines/firestore-rules-scorecard.json'),
      changed('packages/conformance/baselines/storage-rules-scorecard.json'),
      changed('packages/conformance/baselines/rtdb-rules-scorecard.json'),
    ]],
    ['rename inside the rules package', [changed('packages/rules/src/new.ts', 'packages/rules/src/old.ts')]],
  ];

  test.each(rulesOnlySets)('picks rules-only for a %s change, while the gating set stays full', (_name, paths) => {
    expect(selectShadowCheckSet(pr(paths))).toBe('rules-only');
    expect(selectPrCheckSet(pr(paths))).toBe('full');
  });

  test.each([
    ['pyric', 'packages/pyric/src/firestore/index.ts'],
    ['cli', 'packages/cli/src/serve/rules.ts'],
    ['a workflow', '.github/workflows/build.yml'],
    ['the CI planner', 'scripts/ci/plan.ts'],
    ['conformance code', 'packages/conformance/src/firestore-rules-scorecard.ts'],
    ['assurance node counts', 'packages/conformance/assurance-node-counts/firestore-rules/2600.json'],
    ['another service observation', 'packages/conformance/observations/firestore/x.json'],
    ['the root manifest', 'package.json'],
  ])('does not pick rules-only when the change also touches %s', (_name, path) => {
    const paths = [changed('packages/rules/src/simulator/evaluation-builtins.ts'), changed(path)];
    expect(selectShadowCheckSet(pr(paths))).toBe('none');
  });

  test('a rename into the rules package from outside it is not rules-only', () => {
    expect(selectShadowCheckSet(pr([changed('packages/rules/src/moved.ts', 'packages/pyric/src/moved.ts')]))).toBe('none');
  });

  test('an empty change, full-proof labels and non-PR events record none', () => {
    const paths = [changed('packages/rules/src/index.ts')];
    expect(selectShadowCheckSet(pr([]))).toBe('none');
    expect(selectShadowCheckSet(pr(paths, ['ci-full']))).toBe('none');
    expect(selectShadowCheckSet(pr(paths, ['ci-packaging']))).toBe('none');
    for (const event of ['push', 'merge_group', 'schedule', 'workflow_dispatch'] as const) {
      expect(selectShadowCheckSet({ event, labels: [], paths })).toBe('none');
    }
  });

  test('the gating selection is unchanged for every case the selection tests cover', () => {
    const cases: Array<[CheckSetInput, PrCheckSet]> = [
      [pr([changed('scripts/publish-alpha.sh')]), 'release-only'],
      [pr([changed('packages/site-docs/src/content/get-started.md')]), 'docs-only'],
      [pr([changed('PRIORITIES.md')]), 'docs-only'],
      [pr([changed('CONTEXT.md'), changed('AGENTS.md')]), 'docs-only'],
      [pr([changed('.github/pull_request_template.md')]), 'docs-only'],
      [pr([changed('scripts/publish-alpha.sh'), changed('packages/site-docs/src/content/get-started.md')]), 'full'],
      [pr([changed('packages/site-docs/src/content/component.ts')]), 'full'],
      [pr([changed('README.md')]), 'full'],
      [pr([changed('scripts/prepare-release.sh')]), 'full'],
      [pr([changed('new-area/config.txt')]), 'full'],
      [pr([changed('scripts/publish-alpha.sh', 'scripts/old-publisher.sh')]), 'full'],
      [pr([changed('scripts/publish-alpha.sh')], ['ci-full']), 'full'],
      [pr([changed('scripts/publish-alpha.sh')], ['ci-packaging']), 'full'],
      [{ event: 'push', labels: [], paths: [changed('scripts/publish-alpha.sh')] }, 'full'],
      [{ event: 'merge_group', labels: [], paths: [changed('scripts/publish-alpha.sh')] }, 'full'],
      [{ event: 'merge_group', labels: [], paths: [changed('PRIORITIES.md')] }, 'full'],
      [pr([changed('scripts/publish-alpha.sh'), changed('package.json')]), 'full'],
      [pr([changed('packages/site-docs/src/content/overview.md'), changed('package.json')]), 'full'],
    ];
    for (const [input, gating] of cases) {
      expect(selectPrCheckSet(input)).toBe(gating);
      expect(selectShadowCheckSet(input)).toBe('none');
    }
  });

  test('every file the rules-only proof names exists', () => {
    const root = resolve(import.meta.dir, '../..');
    const files = RULES_ONLY_PROOF.flatMap((command) => command.split(' ').filter((word) => word.endsWith('.ts')));
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) expect(existsSync(resolve(root, file))).toBe(true);
    const manifest = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')) as { scripts: Record<string, string> };
    expect(manifest.scripts['compat:rules-score']).toBeDefined();
  });
});

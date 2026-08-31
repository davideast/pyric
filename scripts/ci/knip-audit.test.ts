import { describe, expect, test } from 'bun:test';
import {
  categorizeFindings,
  formatMarkdownReport,
  normalizePath,
  parseKnipReport,
  type KnipRawReport,
  type NormalizedFinding,
} from './knip-audit.ts';

describe('knip-audit', () => {
  test('normalizePath strips leading relative indicators and absolute paths', () => {
    expect(normalizePath('./packages/cli/src/index.ts')).toBe('packages/cli/src/index.ts');
    expect(normalizePath('packages\\cli\\src\\index.ts')).toBe('packages/cli/src/index.ts');
  });

  test('parseKnipReport correctly extracts unused files, dependencies, peer dependencies, exports, and types', () => {
    const rawReport: KnipRawReport = {
      issues: [
        {
          file: 'packages/cli/package.json',
          dependencies: [{ name: 'lodash', packageJsonPath: 'packages/cli/package.json' }],
          devDependencies: [{ name: '@types/lodash', packageJsonPath: 'packages/cli/package.json' }],
          optionalPeerDependencies: [{ name: 'peer-dep', packageJsonPath: 'packages/cli/package.json' }],
        },
        {
          file: 'packages/cli/src/foo.ts',
          files: [{ name: 'packages/cli/src/unused-file.ts' }],
          exports: [{ name: 'unusedFunc', line: 12, col: 4 }],
          types: [{ name: 'UnusedType', line: 20, col: 2 }],
        },
      ],
    };

    const findings = parseKnipReport(rawReport);

    expect(findings).toContainEqual({
      type: 'unused-dependency',
      file: 'packages/cli/package.json',
      name: 'lodash',
      packageJsonPath: 'packages/cli/package.json',
    });

    expect(findings).toContainEqual({
      type: 'unused-dev-dependency',
      file: 'packages/cli/package.json',
      name: '@types/lodash',
      packageJsonPath: 'packages/cli/package.json',
    });

    expect(findings).toContainEqual({
      type: 'unused-dependency',
      file: 'packages/cli/package.json',
      name: 'peer-dep',
      packageJsonPath: 'packages/cli/package.json',
    });

    expect(findings).toContainEqual({
      type: 'unused-file',
      file: 'packages/cli/src/unused-file.ts',
      name: 'packages/cli/src/unused-file.ts',
    });

    expect(findings).toContainEqual({
      type: 'unused-export',
      file: 'packages/cli/src/foo.ts',
      name: 'unusedFunc',
      line: 12,
      col: 4,
    });

    expect(findings).toContainEqual({
      type: 'unused-type',
      file: 'packages/cli/src/foo.ts',
      name: 'UnusedType',
      line: 20,
      col: 2,
    });
  });

  test('categorizeFindings separates PR findings from legacy workspace debt', () => {
    const findings: NormalizedFinding[] = [
      {
        type: 'unused-export',
        file: 'packages/cli/src/modified.ts',
        name: 'newUnusedExport',
      },
      {
        type: 'unused-export',
        file: 'packages/pyric/src/legacy.ts',
        name: 'oldUnusedExport',
      },
      {
        type: 'unused-dependency',
        file: 'packages/cli/package.json',
        name: 'unused-pkg',
        packageJsonPath: 'packages/cli/package.json',
      },
    ];

    const changedPaths = ['packages/cli/src/modified.ts', 'packages/cli/package.json'];
    const result = categorizeFindings(findings, changedPaths, true);

    expect(result.prFindings).toHaveLength(2);
    expect(result.prFindings.map((f) => f.name)).toEqual(['newUnusedExport', 'unused-pkg']);

    expect(result.legacyFindings).toHaveLength(1);
    expect(result.legacyFindings[0].name).toBe('oldUnusedExport');
  });

  test('formatMarkdownReport produces clean Markdown for PR with 0 findings in changes', () => {
    const findings: NormalizedFinding[] = [
      {
        type: 'unused-export',
        file: 'packages/pyric/src/legacy.ts',
        name: 'oldUnusedExport',
      },
    ];

    const categorized = categorizeFindings(findings, ['packages/cli/src/clean.ts'], true);
    const markdown = formatMarkdownReport(categorized);

    expect(markdown).toContain('## ✂️ Advisory Knip Audit');
    expect(markdown).toContain('No unused code or dependencies introduced in PR changes');
    expect(markdown).toContain('Workspace Baseline Debt (filtered out of PR check)');
    expect(markdown).toContain('strictly advisory and non-blocking');
  });

  test('formatMarkdownReport formats table when PR introduces unused findings', () => {
    const findings: NormalizedFinding[] = [
      {
        type: 'unused-export',
        file: 'packages/cli/src/new.ts',
        name: 'deadFunc',
        line: 15,
      },
      {
        type: 'unused-dev-dependency',
        file: 'packages/cli/package.json',
        name: 'unused-dev-pkg',
        packageJsonPath: 'packages/cli/package.json',
      },
    ];

    const categorized = categorizeFindings(findings, ['packages/cli/src/new.ts', 'packages/cli/package.json'], true);
    const markdown = formatMarkdownReport(categorized);

    expect(markdown).toContain('## ✂️ Advisory Knip Audit');
    expect(markdown).toContain('advisory finding(s) detected in PR changes (non-blocking)');
    expect(markdown).toContain('`packages/cli/src/new.ts`');
    expect(markdown).toContain('`deadFunc`');
    expect(markdown).toContain('`unused-dev-pkg`');
    expect(markdown).toContain('devDependencies');
  });
});

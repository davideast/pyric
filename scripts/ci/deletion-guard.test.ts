import { describe, expect, test } from 'bun:test';
import {
  ACKNOWLEDGEMENT,
  changedWorkflows,
  deletedTests,
  isTestPath,
  parseNameStatus,
  removedJobs,
  verdict,
  workflowJobs,
} from './deletion-guard.ts';

describe('parseNameStatus', () => {
  test('reads modified, deleted, added and renamed records', () => {
    const output = [
      'M', 'packages/pyric/src/index.ts',
      'D', 'packages/cli/test/apps/run.test.ts',
      'A', 'scripts/ci/new.ts',
      'R087', 'packages/cli/test/old.test.ts', 'packages/cli/src/old.ts',
      '',
    ].join('\0');
    expect(parseNameStatus(output)).toEqual([
      { status: 'M', path: 'packages/pyric/src/index.ts' },
      { status: 'D', path: 'packages/cli/test/apps/run.test.ts' },
      { status: 'A', path: 'scripts/ci/new.ts' },
      { status: 'R087', path: 'packages/cli/src/old.ts', previousPath: 'packages/cli/test/old.test.ts' },
    ]);
  });

  test('reads an empty diff as no records', () => {
    expect(parseNameStatus('')).toEqual([]);
  });

  test('rejects a truncated record', () => {
    expect(() => parseNameStatus('R100\0only-one-path\0')).toThrow('incomplete R100 record');
    expect(() => parseNameStatus('D\0')).toThrow('incomplete D record');
  });
});

describe('isTestPath', () => {
  test('matches test directories at any depth and test file names', () => {
    for (const path of [
      'test/apps/vite-app/package.json',
      'packages/cli/test/serve/host.ts',
      'packages/ui/tests/button.tsx',
      'packages/pyric/src/__tests__/a.ts',
      'packages/conformance/fixtures/doc.json',
      'packages/pyric-admin/src/auth/auth.test.ts',
      'packages/site/src/nav.spec.tsx',
      'packages/cli/test/e2e/vite-peer-install.pw.ts',
      'scripts/ci/plan.test.ts',
      'scripts/check.test.mjs',
    ]) {
      expect(isTestPath(path), path).toBe(true);
    }
  });

  test('does not match source files whose names only contain the word', () => {
    for (const path of [
      'packages/pyric/src/testing.ts',
      'packages/cli/src/test-runner/index.ts',
      'packages/pyric/src/contest.test-data.json',
      'docs/tests.md',
    ]) {
      expect(isTestPath(path), path).toBe(false);
    }
  });
});

describe('deletedTests', () => {
  test('lists deleted test files and tests renamed out of a test location', () => {
    expect(deletedTests([
      { status: 'D', path: 'test/apps/vite-app/index.html' },
      { status: 'D', path: 'packages/pyric/src/old.ts' },
      { status: 'M', path: 'packages/pyric/test/a.test.ts' },
      { status: 'R100', previousPath: 'packages/pyric/test/b.test.ts', path: 'packages/pyric/test/c.test.ts' },
      { status: 'R090', previousPath: 'packages/pyric/test/d.test.ts', path: 'packages/pyric/src/d.ts' },
    ])).toEqual([
      'test/apps/vite-app/index.html',
      'packages/pyric/test/d.test.ts (renamed to packages/pyric/src/d.ts)',
    ]);
  });
});

describe('workflow jobs', () => {
  const before = `
name: Build & Test
on:
  pull_request:
jobs:
  plan:
    runs-on: ubuntu-latest
    steps:
      - run: echo plan
  app-scenarios:
    runs-on: ubuntu-latest
    steps:
      - run: echo apps
  required:
    needs: [plan, app-scenarios]
    runs-on: ubuntu-latest
    steps:
      - run: echo ok
`;
  const after = before.replace(/  app-scenarios:\n(    .*\n|      .*\n)+/, '').replace('[plan, app-scenarios]', '[plan]');

  test('reads the job ids of a workflow', () => {
    expect(workflowJobs(before)).toEqual(['plan', 'app-scenarios', 'required']);
    expect(workflowJobs('')).toEqual([]);
  });

  test('lists jobs removed from a changed workflow, and every job of a deleted one', () => {
    expect(removedJobs('.github/workflows/build.yml', before, after)).toEqual([
      '.github/workflows/build.yml: app-scenarios',
    ]);
    expect(removedJobs('.github/workflows/build.yml', before, '')).toEqual([
      '.github/workflows/build.yml: plan',
      '.github/workflows/build.yml: app-scenarios',
      '.github/workflows/build.yml: required',
    ]);
    expect(removedJobs('.github/workflows/build.yml', before, before)).toEqual([]);
  });

  test('selects changed, deleted and renamed workflow files, not added ones or other YAML', () => {
    expect(changedWorkflows([
      { status: 'M', path: '.github/workflows/build.yml' },
      { status: 'D', path: '.github/workflows/old.yaml' },
      { status: 'A', path: '.github/workflows/new.yml' },
      { status: 'R100', previousPath: '.github/workflows/a.yml', path: '.github/workflows/b.yml' },
      { status: 'M', path: '.github/actions/restore-dist/action.yml' },
      { status: 'M', path: 'pnpm-workspace.yml' },
    ])).toEqual(['.github/workflows/build.yml', '.github/workflows/old.yaml', '.github/workflows/a.yml']);
  });
});

describe('verdict', () => {
  test('passes a pull request that removes nothing, whatever its body', () => {
    expect(verdict({ tests: [], jobs: [], body: '' }).ok).toBe(true);
  });

  test('fails removals without the acknowledgement line, naming what was removed', () => {
    const { ok, report } = verdict({
      tests: ['test/apps/vite-app/index.html'],
      jobs: ['.github/workflows/build.yml: app-scenarios'],
      body: 'Rebases onto main.\n\nThis removes tests: none.',
    });
    expect(ok).toBe(false);
    expect(report).toContain('- test/apps/vite-app/index.html');
    expect(report).toContain('- .github/workflows/build.yml: app-scenarios');
    expect(report).toContain('Removes tests: <reason>');
  });

  test('passes removals the body acknowledges on a line of its own, with CRLF line endings', () => {
    const body = 'Drops the legacy harness.\r\n\r\nRemoves tests: the harness moved to packages/cli/test/e2e\r\n';
    const { ok, report } = verdict({ tests: ['packages/cli/test/old/harness.ts'], jobs: [], body });
    expect(ok).toBe(true);
    expect(report).toContain('Removes tests: the harness moved to packages/cli/test/e2e');
  });

  test('does not accept the template placeholder, an empty reason or an inline mention', () => {
    expect(ACKNOWLEDGEMENT.test('Removes tests: <reason>')).toBe(false);
    expect(ACKNOWLEDGEMENT.test('Removes tests:')).toBe(false);
    expect(ACKNOWLEDGEMENT.test('Removes tests:   ')).toBe(false);
    expect(ACKNOWLEDGEMENT.test('add a line `Removes tests: why`')).toBe(false);
    expect(ACKNOWLEDGEMENT.test('Removes tests: superseded by the shared harness')).toBe(true);
  });
});

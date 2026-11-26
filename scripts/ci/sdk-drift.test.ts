import { describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  closeOpenIssue,
  findOpenIssue,
  isGraphQlOrTransientGhError,
  openOrUpdateIssue,
  type Gh,
} from './github-issues.ts';
import {
  ISSUE_LABEL,
  blamedPackages,
  declaredRanges,
  failingTests,
  fileIssues,
  issueTitle,
  issueTitlePrefix,
  rewriteSpecifiers,
  selectVersion,
  type DriftResult,
  type RegistryDocument,
} from './sdk-drift.ts';

const registry: RegistryDocument = {
  'dist-tags': { latest: '13.1.0', next: '13.2.0-beta.1' },
  versions: {
    '12.12.0': {},
    '12.13.0': {},
    '12.19.0': {},
    '12.20.0': { deprecated: 'published by mistake' },
    '12.21.0-canary.3f2a': {},
    '13.0.0': {},
    '13.1.0': {},
    '13.2.0-beta.1': {},
  },
};

describe('version selection', () => {
  test('in-range picks the newest stable, undeprecated release the range allows', () => {
    expect(selectVersion(registry, 'in-range', '^12.12.0')).toBe('12.19.0');
  });

  test('latest picks the dist-tag, even outside the declared range', () => {
    expect(selectVersion(registry, 'latest', '^12.12.0')).toBe('13.1.0');
  });

  test('in-range fails loudly when nothing satisfies the range', () => {
    expect(() => selectVersion(registry, 'in-range', '^14.0.0')).toThrow('^14.0.0');
  });

  test('latest fails loudly when the registry has no latest tag', () => {
    expect(() => selectVersion({ 'dist-tags': {}, versions: {} }, 'latest', '^12.0.0')).toThrow('latest');
  });
});

describe('declared ranges', () => {
  test('reads both SDK ranges from the pyric manifest', () => {
    expect(declaredRanges({
      devDependencies: { firebase: '^12.12.0', 'firebase-admin': '^13.0.0', typescript: '^5.7.0' },
    })).toEqual({ firebase: '^12.12.0', 'firebase-admin': '^13.0.0' });
  });

  test('fails when a range is missing', () => {
    expect(() => declaredRanges({ devDependencies: { firebase: '^12.12.0' } })).toThrow('firebase-admin');
  });
});

describe('specifier rewriting', () => {
  const versions = { firebase: '13.1.0', 'firebase-admin': '14.5.0' };

  test('rewrites only the two SDK specifiers, in every dependency section', () => {
    const manifest = {
      name: 'x',
      dependencies: { firebase: '^12.12.0', 'firebase-functions': '^7.2.5' },
      devDependencies: { 'firebase-admin': '^13.0.0', typescript: '^5.7.0' },
      optionalDependencies: { firebase: '~12.13.0' },
    };
    expect(rewriteSpecifiers(manifest, versions)).toEqual({
      name: 'x',
      dependencies: { firebase: '13.1.0', 'firebase-functions': '^7.2.5' },
      devDependencies: { 'firebase-admin': '14.5.0', typescript: '^5.7.0' },
      optionalDependencies: { firebase: '13.1.0' },
    });
  });

  test('keeps peer dependency ranges, which describe what users may install', () => {
    const manifest = { peerDependencies: { firebase: '>=12' }, devDependencies: { firebase: '^12.12.0' } };
    expect(rewriteSpecifiers(manifest, versions)).toEqual({
      peerDependencies: { firebase: '>=12' },
      devDependencies: { firebase: '13.1.0' },
    });
  });

  test('a $firebase override keeps pointing at the rewritten root specifier', () => {
    const root = {
      overrides: { firebase: '$firebase' },
      devDependencies: { firebase: '12.13.0', 'firebase-admin': '^13.0.0' },
    };
    const rewritten = rewriteSpecifiers(root, versions);
    expect(rewritten.overrides).toEqual({ firebase: '$firebase' });
    expect(rewritten.devDependencies).toEqual({ firebase: '13.1.0', 'firebase-admin': '14.5.0' });
  });

  test('a literal override moves with the rewrite, so it cannot pin the old version', () => {
    const root = { overrides: { firebase: '12.13.0', zod: '3.23.0' } };
    expect(rewriteSpecifiers(root, versions).overrides).toEqual({ firebase: '13.1.0', zod: '3.23.0' });
  });

  test('does not mutate its input', () => {
    const manifest = { devDependencies: { firebase: '^12.12.0' } };
    rewriteSpecifiers(manifest, versions);
    expect(manifest.devDependencies.firebase).toBe('^12.12.0');
  });
});

describe('failing test extraction', () => {
  test('lists bun test (fail) lines without color codes or timings', () => {
    const output = [
      '(pass) storage > uploads [1.20ms]',
      '\u001b[31m(fail)\u001b[0m firestore > orderBy rejects a missing field [12.34ms]',
      '(fail) auth > signIn keeps tenantId',
      ' 2 fail',
    ].join('\n');
    expect(failingTests(output)).toEqual([
      'firestore > orderBy rejects a missing field',
      'auth > signIn keeps tenantId',
    ]);
  });

  test('deduplicates repeated (fail) lines printed in streaming output and summary', () => {
    const output = [
      '(fail) firestore > orderBy rejects a missing field [12.34ms]',
      '(fail) auth > signIn keeps tenantId [3.00ms]',
      '(fail) firestore > orderBy rejects a missing field [12.34ms]',
      '(fail) auth > signIn keeps tenantId',
    ].join('\n');
    expect(failingTests(output)).toEqual([
      'firestore > orderBy rejects a missing field',
      'auth > signIn keeps tenantId',
    ]);
  });
});

describe('issue titles', () => {
  test('names the package and version', () => {
    expect(issueTitle('firebase', '13.1.0')).toBe('pyric fails against firebase 13.1.0');
  });

  test('the search prefix is shared by every release of one major', () => {
    expect(issueTitle('firebase', '13.4.2').startsWith(issueTitlePrefix('firebase', '13.1.0'))).toBe(true);
    expect(issueTitle('firebase', '14.0.0').startsWith(issueTitlePrefix('firebase', '13.1.0'))).toBe(false);
    expect(issueTitle('firebase-admin', '13.1.0').startsWith(issueTitlePrefix('firebase', '13.1.0'))).toBe(false);
  });

  test('drift issues are filed under the bug label', () => {
    expect(ISSUE_LABEL).toBe('bug');
  });
});

describe('blamed packages', () => {
  const ranges = { firebase: '^12.12.0', 'firebase-admin': '^13.0.0' };

  test('blames only the packages that left the declared range', () => {
    expect(blamedPackages({ firebase: '13.1.0', 'firebase-admin': '13.10.0' }, ranges)).toEqual(['firebase']);
  });

  test('blames both when both left the range, or when neither did', () => {
    expect(blamedPackages({ firebase: '13.1.0', 'firebase-admin': '14.5.0' }, ranges)).toEqual(['firebase', 'firebase-admin']);
    expect(blamedPackages({ firebase: '12.19.0', 'firebase-admin': '13.10.0' }, ranges)).toEqual(['firebase', 'firebase-admin']);
  });
});

function withScratchDir<T>(run: (dir: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), 'sdk-drift-test-'));
  try {
    return run(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function sampleFailedResult(): DriftResult {
  return {
    tier: 'latest',
    ranges: { firebase: '^13.4.0', 'firebase-admin': '^14.5.1' },
    selected: { firebase: '13.4.0', 'firebase-admin': '14.5.1' },
    resolved: { firebase: '13.4.0', 'firebase-admin': '14.5.1' },
    steps: [
      {
        name: 'packages/cli',
        gates: true,
        exitCode: 1,
        failingTests: ['functions-http > serves v1 https.onRequest'],
      },
    ],
    failed: true,
    runUrl: 'https://github.com/davideast/pyric/actions/runs/45644405738',
  };
}

describe('GitHub issue GraphQL -> REST fallback and fileIssues', () => {
  test('classifies GitHub GraphQL and transient 5xx errors without catching 4xx validation errors', () => {
    expect(
      isGraphQlOrTransientGhError(
        new Error(
          'gh issue create failed: GraphQL: Something went wrong while executing your query on 2026-11-25T16:07:21Z.',
        ),
      ),
    ).toBe(true);
    expect(isGraphQlOrTransientGhError(new Error('gh issue create failed: HTTP 502 Bad Gateway'))).toBe(true);
    expect(isGraphQlOrTransientGhError(new Error('gh issue create failed: HTTP 422 Validation Failed'))).toBe(false);
  });

  test('fileIssues recovers from gh issue create GraphQL crash via REST API and cleans up payload files', () => {
    withScratchDir((dir) => {
      const resultPath = join(dir, 'sdk-drift-result.json');
      writeFileSync(resultPath, JSON.stringify(sampleFailedResult()));
      const restPayloads: Array<{ path: string; body: Record<string, unknown> }> = [];
      const createdPayloadPaths: string[] = [];
      const calls: string[][] = [];

      const gh: Gh = (args) => {
        calls.push(args);
        if (args[0] === 'issue' && args[1] === 'list') {
          return '[]';
        }
        if (args[0] === 'issue' && args[1] === 'create') {
          throw new Error(
            'gh issue create failed: GraphQL: Something went wrong while executing your query on 2026-11-25T16:07:21Z. Please include `E402:2FF470:CC981F:DAB5DC:6B0707B8` when reporting this issue.',
          );
        }
        if (args[0] === 'api' && args[1] === '-X' && args[2] === 'POST') {
          const inputIdx = args.indexOf('--input');
          const payloadFile = args[inputIdx + 1] ?? '';
          createdPayloadPaths.push(payloadFile);
          restPayloads.push({
            path: args[3] ?? '',
            body: JSON.parse(readFileSync(payloadFile, 'utf8')) as Record<string, unknown>,
          });
          return `https://github.com/davideast/pyric/issues/${900 + restPayloads.length}\n`;
        }
        throw new Error(`unexpected gh invocation: ${args.join(' ')}`);
      };

      const logged: string[] = [];
      const urls = fileIssues(resultPath, {
        gh,
        log: (line) => logged.push(line),
        repository: 'davideast/pyric',
      });

      expect(urls).toEqual([
        'https://github.com/davideast/pyric/issues/901',
        'https://github.com/davideast/pyric/issues/902',
      ]);
      expect(logged).toEqual(urls);
      expect(restPayloads).toHaveLength(2);
      expect(restPayloads[0]?.path).toBe('repos/davideast/pyric/issues');
      expect(restPayloads[0]?.body.title).toBe('pyric fails against firebase 13.4.0');
      expect(restPayloads[0]?.body.labels).toEqual(['bug']);
      expect(String(restPayloads[0]?.body.body)).toContain('45644405738');
      expect(restPayloads[1]?.body.title).toBe('pyric fails against firebase-admin 14.5.1');
      for (const payloadPath of createdPayloadPaths) {
        expect(existsSync(payloadPath)).toBe(false);
      }
    });
  });

  test('falls back to REST on GraphQL crashes for issue list, comment, edit, and close', () => {
    withScratchDir((dir) => {
      const bodyFile = join(dir, 'body.md');
      writeFileSync(bodyFile, 'Latest drift summary');
      const apiCalls: Array<{ method: string; endpoint: string; payload?: Record<string, unknown> }> = [];

      const gh: Gh = (args) => {
        if (args[0] === 'issue') {
          throw new Error(`gh issue ${args[1]} failed: GraphQL: Something went wrong while executing your query`);
        }
        if (
          args[0] === 'api' &&
          args[1] === '--paginate' &&
          args[2] === '--slurp' &&
          args[3] === 'repos/davideast/pyric/issues?state=open&per_page=100'
        ) {
          apiCalls.push({ method: 'GET', endpoint: args[3] });
          return JSON.stringify([
            [
              { number: 400, title: 'pyric fails against firebase 13.0.0', pull_request: {} },
              { number: 399, title: 'unrelated page 1 issue' },
            ],
            [
              { number: 300, title: 'pyric fails against firebase 13.1.0', pull_request: {} },
              { number: 401, title: 'pyric fails against firebase 13.1.0' },
            ],
          ]);
        }
        if (args[0] === 'api' && args[1] === '-X') {
          const method = args[2] ?? '';
          const endpoint = args[3] ?? '';
          const inputIdx = args.indexOf('--input');
          const payloadFile = args[inputIdx + 1] ?? '';
          const payload = JSON.parse(readFileSync(payloadFile, 'utf8')) as Record<string, unknown>;
          apiCalls.push({ method, endpoint, payload });
          return 'https://github.com/davideast/pyric/issues/401#issuecomment-1\n';
        }
        throw new Error(`unexpected gh invocation: ${args.join(' ')}`);
      };

      expect(findOpenIssue(gh, 'pyric fails against firebase 13.', 'davideast/pyric')).toBe(401);

      const url = openOrUpdateIssue(gh, {
        prefix: 'pyric fails against firebase 13.',
        title: 'pyric fails against firebase 13.4.0',
        label: ISSUE_LABEL,
        bodyFile,
        repository: 'davideast/pyric',
      });
      expect(url).toBe('https://github.com/davideast/pyric/issues/401#issuecomment-1');

      const closed = closeOpenIssue(
        gh,
        'pyric fails against firebase 13.',
        bodyFile,
        'davideast/pyric',
      );
      expect(closed).toBe(401);

      expect(apiCalls.some((c) => c.method === 'POST' && c.endpoint === 'repos/davideast/pyric/issues/401/comments')).toBe(true);
      expect(
        apiCalls.some(
          (c) =>
            c.method === 'PATCH' &&
            c.endpoint === 'repos/davideast/pyric/issues/401' &&
            c.payload?.title === 'pyric fails against firebase 13.4.0',
        ),
      ).toBe(true);
      expect(
        apiCalls.some(
          (c) =>
            c.method === 'PATCH' &&
            c.endpoint === 'repos/davideast/pyric/issues/401' &&
            c.payload?.state === 'closed',
        ),
      ).toBe(true);
    });
  });

  test('findOpenIssue REST fallback scans all paginated pages and skips pull requests', () => {
    const ghMultiPage: Gh = (args) => {
      if (args[0] === 'issue') {
        throw new Error('gh issue list failed: GraphQL: Something went wrong while executing your query');
      }
      if (
        args[0] === 'api' &&
        args[1] === '--paginate' &&
        args[2] === '--slurp' &&
        args[3] === 'repos/davideast/pyric/issues?state=open&per_page=100'
      ) {
        const page1: Array<Record<string, unknown>> = [
          { number: 1000, title: 'pyric fails against firebase 13.2.0', pull_request: {} },
        ];
        for (let i = 1; i < 100; i += 1) {
          page1.push({ number: 1000 - i, title: `unrelated issue ${i}` });
        }
        const page2 = [
          { number: 500, title: 'pyric fails against firebase 13.3.0', pull_request: {} },
          { number: 499, title: 'pyric fails against firebase 13.4.0' },
        ];
        return JSON.stringify([page1, page2]);
      }
      throw new Error(`unexpected gh invocation: ${args.join(' ')}`);
    };

    expect(findOpenIssue(ghMultiPage, 'pyric fails against firebase 13.', 'davideast/pyric')).toBe(499);
    expect(findOpenIssue(ghMultiPage, 'pyric fails against firebase-admin 14.', 'davideast/pyric')).toBeUndefined();
  });

  test('fileIssues attempts all blamed packages before throwing and skips passing runs', () => {
    withScratchDir((dir) => {
      const passingPath = join(dir, 'passing.json');
      writeFileSync(passingPath, JSON.stringify({ ...sampleFailedResult(), failed: false }));
      const passLogs: string[] = [];
      expect(fileIssues(passingPath, { log: (line) => passLogs.push(line) })).toEqual([]);
      expect(passLogs).toEqual(['The run passed; no issue to file.']);

      const failingPath = join(dir, 'failing.json');
      writeFileSync(failingPath, JSON.stringify(sampleFailedResult()));
      const attemptedTitles: string[] = [];
      const gh: Gh = (args) => {
        if (args[0] === 'issue' && args[1] === 'list') return '[]';
        if (args[0] === 'issue' && args[1] === 'create') {
          const title = args[args.indexOf('--title') + 1] ?? '';
          attemptedTitles.push(title);
          if (title.includes('firebase 13.4.0')) {
            throw new Error('gh issue create failed: HTTP 403 Forbidden');
          }
          return 'https://github.com/davideast/pyric/issues/999\n';
        }
        return '';
      };

      expect(() => fileIssues(failingPath, { gh, log: () => {} })).toThrow(
        /firebase@13\.4\.0: gh issue create failed: HTTP 403 Forbidden/,
      );
      expect(attemptedTitles).toEqual([
        'pyric fails against firebase 13.4.0',
        'pyric fails against firebase-admin 14.5.1',
      ]);
    });
  });
});

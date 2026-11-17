import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  formatVerdictComment,
  formatVerdictMarker,
  parseVerdictMarkers,
  type CampaignAxis,
  type CampaignVerdict,
  type VerdictCommentInput,
  type VerdictMarkerInput,
} from './campaign-verdict-markers.ts';
import {
  parseVerdictCliArgs,
  resolveTempRoot,
  runVerdictCli,
  type VerdictCliIo,
} from './campaign-verdict.ts';

const SHA_A = '803cd688bfb1305a2b8e7ebff2f36c34fbee9b35';

describe('formatVerdictMarker', () => {
  test('formats a hidden HTML marker with lowercase 40-char SHA', () => {
    const input: VerdictMarkerInput = {
      axis: 'spec',
      verdict: 'MERGE',
      sha: SHA_A.toUpperCase(),
    };
    expect(formatVerdictMarker(input)).toBe(
      `<!-- campaign-verdict axis=spec verdict=MERGE sha=${SHA_A} -->`,
    );
  });

  test('rejects short or non-hex commit SHAs', () => {
    expect(() =>
      formatVerdictMarker({ axis: 'spec', verdict: 'MERGE', sha: '803cd688b' }),
    ).toThrow(/40-character hex commit SHA/);
    expect(() =>
      formatVerdictMarker({ axis: 'standards', verdict: 'FIX', sha: 'z'.repeat(40) }),
    ).toThrow(/40-character hex commit SHA/);
  });

  test('rejects unknown axis or verdict values at runtime', () => {
    expect(() =>
      formatVerdictMarker({
        axis: 'style' as CampaignAxis,
        verdict: 'MERGE',
        sha: SHA_A,
      }),
    ).toThrow(/--axis/);
    expect(() =>
      formatVerdictMarker({
        axis: 'spec',
        verdict: 'APPROVE' as CampaignVerdict,
        sha: SHA_A,
      }),
    ).toThrow(/--verdict/);
  });
});

describe('formatVerdictComment and round-trip parsing', () => {
  test('renders human summary header, trimmed body, and trailing hidden marker that round-trips', () => {
    const input: VerdictCommentInput = {
      axis: 'standards',
      verdict: 'FIX',
      sha: SHA_A,
      summary: '  1. Split helper module to stay under 600 lines.\n',
    };
    const comment = formatVerdictComment(input);

    expect(comment).toBe(
      [
        `**Campaign review (\`standards\`):** \`FIX\` at \`${SHA_A}\``,
        '',
        '1. Split helper module to stay under 600 lines.',
        '',
        `<!-- campaign-verdict axis=standards verdict=FIX sha=${SHA_A} -->`,
      ].join('\n'),
    );
    expect(parseVerdictMarkers(comment)).toEqual([
      { axis: 'standards', verdict: 'FIX', sha: SHA_A },
    ]);
  });

  test('preserves trailing FIX marker after list-indented code fences and inline `<pre>` spans', () => {
    const comment = formatVerdictComment({
      axis: 'spec',
      verdict: 'FIX',
      sha: SHA_A,
      summary: [
        '1. Remove inside `<pre>` / `<code>`:',
        '- ```ts',
        '  console.log(1);',
        '  ```',
      ].join('\n'),
    });

    expect(parseVerdictMarkers(comment)).toEqual([
      { axis: 'spec', verdict: 'FIX', sha: SHA_A },
    ]);
  });

  test('rejects empty, non-ASCII, HTML-comment, or unclosed-fence/tag summaries that would swallow the marker', () => {
    expect(() =>
      formatVerdictComment({ axis: 'spec', verdict: 'MERGE', sha: SHA_A, summary: '   ' }),
    ).toThrow(/summary must not be empty/i);

    expect(() =>
      formatVerdictComment({
        axis: 'spec',
        verdict: 'MERGE',
        sha: SHA_A,
        summary: 'Bad arrow \u2192 in summary',
      }),
    ).toThrow(/plain ASCII/i);

    expect(() =>
      formatVerdictComment({
        axis: 'spec',
        verdict: 'MERGE',
        sha: SHA_A,
        summary: 'Contains --> HTML comment terminator',
      }),
    ).toThrow(/HTML comment/i);

    expect(() =>
      formatVerdictComment({
        axis: 'spec',
        verdict: 'FIX',
        sha: SHA_A,
        summary: 'Broken:\n```ts\nconst x = 1;',
      }),
    ).toThrow(/unclosed|round-trip/i);

    expect(() =>
      formatVerdictComment({
        axis: 'spec',
        verdict: 'FIX',
        sha: SHA_A,
        summary: 'Broken HTML:\n<pre>\nconst x = 1;',
      }),
    ).toThrow(/unclosed|round-trip/i);
  });
});

describe('parseVerdictCliArgs, resolveTempRoot, and runVerdictCli', () => {
  test('resolveTempRoot falls back to os.tmpdir() when RUNNER_TEMP is unset or empty', () => {
    expect(resolveTempRoot({})).toBe(tmpdir());
    expect(resolveTempRoot({ RUNNER_TEMP: '' })).toBe(tmpdir());
    expect(resolveTempRoot({ RUNNER_TEMP: '   ' })).toBe(tmpdir());
    expect(resolveTempRoot({ RUNNER_TEMP: '/var/tmp' })).toBe('/var/tmp');
  });

  test('prints the formatted comment when --pr is omitted or --dry-run is passed', () => {
    const ghCalls: string[][] = [];
    const logs: string[] = [];
    const io: VerdictCliIo = {
      gh: (args) => {
        ghCalls.push(args);
        return '{}';
      },
      readText: () => '',
      withBodyFile: (_body, fn) => fn('unused.md'),
      log: (text) => logs.push(text),
    };

    const printArgs = parseVerdictCliArgs(
      ['--axis', 'spec', '--verdict', 'MERGE', '--sha', SHA_A, '--summary', 'All clauses match.'],
      {},
    );
    const printed = runVerdictCli(printArgs, io);
    expect(printed.posted).toBe(false);
    expect(ghCalls).toEqual([]);
    expect(logs).toEqual([printed.comment]);

    logs.length = 0;
    const dryRunArgs = parseVerdictCliArgs(
      [
        '--pr=42',
        '--dry-run',
        '--axis=standards',
        '--verdict=MERGE',
        `--sha=${SHA_A}`,
        '--summary=0 hard violations.',
      ],
      { GITHUB_REPOSITORY: 'davideast/pyric' },
    );
    const dryResult = runVerdictCli(dryRunArgs, io);
    expect(dryResult.posted).toBe(false);
    expect(ghCalls).toEqual([]);
    expect(logs).toEqual([dryResult.comment]);
  });

  test('reads --summary-file, resolves repo from flags or env, and posts via gh api', () => {
    const ghCalls: Array<{ args: string[]; fileText: string }> = [];
    const logs: string[] = [];
    let currentBody = '';
    const io: VerdictCliIo = {
      gh: (args) => {
        ghCalls.push({ args, fileText: currentBody });
        return JSON.stringify({ html_url: 'https://github.com/davideast/pyric/pull/42#issuecomment-99' });
      },
      readText: (path) => {
        expect(path).toBe('summary.md');
        return 'Verified against installed firebase@12.19.0.\n';
      },
      withBodyFile: (body, fn) => {
        currentBody = body;
        return fn('verdict-body.md');
      },
      log: (text) => logs.push(text),
    };

    const args = parseVerdictCliArgs(
      ['--pr', '42', '--axis', 'spec', '--verdict', 'MERGE', '--sha', SHA_A, '--summary-file', 'summary.md'],
      { GH_REPO: 'davideast/pyric' },
    );
    const result = runVerdictCli(args, io);

    expect(result.posted).toBe(true);
    expect(result.commentUrl).toBe('https://github.com/davideast/pyric/pull/42#issuecomment-99');
    expect(ghCalls).toEqual([
      {
        args: ['api', '-X', 'POST', 'repos/davideast/pyric/issues/42/comments', '-F', 'body=@verdict-body.md'],
        fileText: result.comment,
      },
    ]);
    expect(logs).toEqual(['https://github.com/davideast/pyric/pull/42#issuecomment-99']);
  });

  test('uses {owner}/{repo} placeholder when posting locally with no --repo or env repo', () => {
    const ghCalls: string[][] = [];
    const io: VerdictCliIo = {
      gh: (args) => {
        ghCalls.push(args);
        return JSON.stringify({ html_url: 'https://github.com/owner/repo/pull/7#issuecomment-1' });
      },
      readText: () => '',
      withBodyFile: (_body, fn) => fn('body.md'),
      log: () => {},
    };
    const args = parseVerdictCliArgs(
      ['--pr', '7', '--axis', 'standards', '--verdict', 'FIX', '--sha', SHA_A, '--summary', 'Line count > 600.'],
      {},
    );
    runVerdictCli(args, io);
    expect(ghCalls).toEqual([
      ['api', '-X', 'POST', 'repos/{owner}/{repo}/issues/7/comments', '-F', 'body=@body.md'],
    ]);
  });

  test('rejects unknown flags, missing required flags, invalid PR numbers, or conflicting summary flags', () => {
    expect(() =>
      parseVerdictCliArgs(['--unknown', '--axis', 'spec', '--verdict', 'MERGE', '--sha', SHA_A, '--summary', 'ok'], {}),
    ).toThrow(/Unknown argument/);

    expect(() =>
      parseVerdictCliArgs(['--axis', 'spec', '--verdict', 'MERGE', '--sha', SHA_A], {}),
    ).toThrow(/--summary or --summary-file/);

    expect(() =>
      parseVerdictCliArgs(
        ['--axis', 'spec', '--verdict', 'MERGE', '--sha', SHA_A, '--summary', 'a', '--summary-file', 'b.md'],
        {},
      ),
    ).toThrow(/not both/i);

    expect(() =>
      parseVerdictCliArgs(
        ['--pr', '0', '--axis', 'spec', '--verdict', 'MERGE', '--sha', SHA_A, '--summary', 'ok'],
        {},
      ),
    ).toThrow(/positive integer/i);

    expect(() =>
      parseVerdictCliArgs(
        ['--pr', '5', '--repo', 'bad-repo-format', '--axis', 'spec', '--verdict', 'MERGE', '--sha', SHA_A, '--summary', 'ok'],
        {},
      ),
    ).toThrow(/owner\/name/i);
  });

  test('CLI entrypoint posts formatted verdict via gh subprocess and cleans up its temp file even when RUNNER_TEMP is empty', () => {
    const root = mkdtempSync(join(tmpdir(), 'campaign-verdict-cli-'));
    const scriptPath = resolve(import.meta.dir, 'campaign-verdict.ts');
    try {
      const capturedArgsFile = join(root, 'gh-args.txt');
      const capturedBodyFile = join(root, 'gh-body.md');
      const capturedBodyPathFile = join(root, 'gh-body-path.txt');
      const fakeGh = join(root, 'gh');
      writeFileSync(
        fakeGh,
        [
          '#!/usr/bin/env sh',
          'printf "%s\\n" "$@" > "$CAPTURED_ARGS"',
          'for arg in "$@"; do',
          '  case "$arg" in',
          '    body=@*)',
          '      body_path="${arg#body=@}"',
          '      printf "%s" "$body_path" > "$CAPTURED_BODY_PATH"',
          '      cp "$body_path" "$CAPTURED_BODY"',
          '      ;;',
          '  esac',
          'done',
          'printf \'{"html_url":"https://github.com/owner/repo/pull/19#issuecomment-5"}\\n\'',
        ].join('\n'),
      );
      chmodSync(fakeGh, 0o755);

      const out = spawnSync(
        process.execPath,
        [
          scriptPath,
          '--pr',
          '19',
          '--repo',
          'owner/repo',
          '--axis',
          'spec',
          '--verdict',
          'MERGE',
          '--sha',
          SHA_A,
          '--summary',
          'Empirical SDK checks passed.',
        ],
        {
          encoding: 'utf8',
          env: {
            ...process.env,
            PATH: `${root}:${process.env.PATH ?? ''}`,
            RUNNER_TEMP: '',
            CAPTURED_ARGS: capturedArgsFile,
            CAPTURED_BODY: capturedBodyFile,
            CAPTURED_BODY_PATH: capturedBodyPathFile,
          },
        },
      );

      expect(out.status).toBe(0);
      expect(out.stdout.trim()).toBe('https://github.com/owner/repo/pull/19#issuecomment-5');
      const argsLines = readFileSync(capturedArgsFile, 'utf8').trim().split('\n');
      expect(argsLines.slice(0, 5)).toEqual([
        'api',
        '-X',
        'POST',
        'repos/owner/repo/issues/19/comments',
        '-F',
      ]);
      expect(readFileSync(capturedBodyFile, 'utf8')).toContain(
        `<!-- campaign-verdict axis=spec verdict=MERGE sha=${SHA_A} -->`,
      );
      expect(existsSync(readFileSync(capturedBodyPathFile, 'utf8'))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

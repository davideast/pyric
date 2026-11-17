import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { formatVerdictComment } from './campaign-verdict.ts';
import {
  TRUSTED_AUTHOR_ASSOCIATIONS,
  evaluateCampaignVerdicts,
  parseVerdictMarkers,
  reconcileCampaignVerdicts,
  type CampaignComment,
  type CampaignDecisionReason,
  type CampaignPullState,
  type CampaignVerdictDecision,
  type CampaignVerdictFacts,
  type CampaignVerdictsIo,
} from './campaign-verdicts.ts';
import { QUEUE_LABEL } from './merge-queue.ts';

const HEAD_SHA = '1aa55782a4c9e0b1234567890abcdef123456789';
const STALE_SHA = '8e2e4e59f0000000000000000000000000000000';

function basePull(overrides: Partial<CampaignPullState> = {}): CampaignPullState {
  return {
    number: 2669,
    state: 'open',
    isDraft: false,
    baseRef: 'main',
    headSha: HEAD_SHA,
    headRepoFullName: 'davideast/pyric',
    labels: [],
    ...overrides,
  };
}

let nextId = 1;
function makeComment(
  axis: 'spec' | 'standards',
  verdict: 'MERGE' | 'FIX',
  options: {
    sha?: string;
    authorAssociation?: string;
    id?: number;
    summary?: string;
  } = {},
): CampaignComment {
  const id = options.id ?? nextId++;
  return {
    id,
    authorAssociation: options.authorAssociation ?? 'COLLABORATOR',
    body: formatVerdictComment({
      axis,
      verdict,
      sha: options.sha ?? HEAD_SHA,
      summary: options.summary ?? `${axis} review ${verdict}`,
    }),
  };
}

function facts(
  comments: readonly CampaignComment[],
  pullOverrides: Partial<CampaignPullState> = {},
): CampaignVerdictFacts {
  return {
    repo: 'davideast/pyric',
    pull: basePull(pullOverrides),
    comments,
  };
}

describe('parseVerdictMarkers', () => {
  test('parses standalone markers with LF or CRLF line endings and normalizes hex SHAs', () => {
    const body = [
      '**Campaign review (`spec`):** `MERGE`',
      '',
      `<!-- campaign-verdict axis=spec verdict=MERGE sha=${HEAD_SHA.toUpperCase()} -->`,
      `  <!-- campaign-verdict axis=standards verdict=FIX sha=${STALE_SHA} -->  `,
    ].join('\r\n');

    expect(parseVerdictMarkers(body)).toEqual([
      { axis: 'spec', verdict: 'MERGE', sha: HEAD_SHA },
      { axis: 'standards', verdict: 'FIX', sha: STALE_SHA },
    ]);
  });

  test('ignores markers inside fenced code blocks, indented code blocks, blockquotes, inline text, or with invalid SHAs', () => {
    const body = [
      'Example usage:',
      '```markdown',
      `<!-- campaign-verdict axis=spec verdict=MERGE sha=${HEAD_SHA} -->`,
      '```',
      '~~~html',
      `<!-- campaign-verdict axis=standards verdict=MERGE sha=${HEAD_SHA} -->`,
      '~~~',
      `    <!-- campaign-verdict axis=spec verdict=MERGE sha=${HEAD_SHA} -->`,
      `\t<!-- campaign-verdict axis=standards verdict=MERGE sha=${HEAD_SHA} -->`,
      `> <!-- campaign-verdict axis=spec verdict=MERGE sha=${HEAD_SHA} -->`,
      `Inline \`<!-- campaign-verdict axis=spec verdict=MERGE sha=${HEAD_SHA} -->\` text`,
      '<!-- campaign-verdict axis=spec verdict=MERGE sha=shortsha -->',
    ].join('\n');

    expect(parseVerdictMarkers(body)).toEqual([]);
  });
});

describe('evaluateCampaignVerdicts', () => {
  test('labels merge-queue when open, non-draft, targeting main, with trusted MERGE on both axes for head SHA', () => {
    expect([...TRUSTED_AUTHOR_ASSOCIATIONS].sort()).toEqual(['COLLABORATOR', 'MEMBER', 'OWNER']);

    const decision: CampaignVerdictDecision = evaluateCampaignVerdicts(
      facts([
        makeComment('spec', 'MERGE', { authorAssociation: 'OWNER', id: 10 }),
        makeComment('standards', 'MERGE', { authorAssociation: 'MEMBER', id: 20 }),
      ]),
    );

    expect(decision.shouldLabel).toBe(true);
    expect(decision.reason).toBe('ready');
    expect(decision.latestByAxis).toEqual({ spec: 'MERGE', standards: 'MERGE' });
  });

  test('rejects stale SHA verdicts after a new push invalidates old verdicts', () => {
    const decision = evaluateCampaignVerdicts(
      facts([
        makeComment('spec', 'MERGE', { sha: STALE_SHA, id: 10 }),
        makeComment('standards', 'MERGE', { sha: HEAD_SHA, id: 20 }),
      ]),
    );

    expect(decision.shouldLabel).toBe(false);
    expect(decision.reason).toBe('missing-verdict');
    expect(decision.staleVerdictCount).toBe(1);
    expect(decision.latestByAxis).toEqual({ spec: undefined, standards: 'MERGE' });
  });

  test('ignores untrusted author associations for both MERGE and FIX comments', () => {
    for (const association of ['CONTRIBUTOR', 'FIRST_TIME_CONTRIBUTOR', 'FIRST_TIMER', 'MANNEQUIN', 'NONE', '']) {
      const mergeAttempt = evaluateCampaignVerdicts(
        facts([
          makeComment('spec', 'MERGE', { authorAssociation: 'COLLABORATOR', id: 10 }),
          makeComment('standards', 'MERGE', { authorAssociation: association, id: 20 }),
        ]),
      );
      expect(mergeAttempt.shouldLabel).toBe(false);
      expect(mergeAttempt.reason).toBe('missing-verdict');
      expect(mergeAttempt.untrustedVerdictCount).toBe(1);
    }

    const spoofedFix = evaluateCampaignVerdicts(
      facts([
        makeComment('spec', 'MERGE', { authorAssociation: 'OWNER', id: 10 }),
        makeComment('standards', 'MERGE', { authorAssociation: 'COLLABORATOR', id: 20 }),
        makeComment('spec', 'FIX', { authorAssociation: 'NONE', id: 30 }),
      ]),
    );
    expect(spoofedFix.shouldLabel).toBe(true);
    expect(spoofedFix.reason).toBe('ready');
    expect(spoofedFix.untrustedVerdictCount).toBe(1);
  });

  test('rejects when a later FIX verdict exists on either axis, regardless of comment order across axes', () => {
    const fixAtEnd = evaluateCampaignVerdicts(
      facts([
        makeComment('spec', 'MERGE', { id: 10 }),
        makeComment('standards', 'MERGE', { id: 20 }),
        makeComment('spec', 'FIX', { id: 30 }),
      ]),
    );
    expect(fixAtEnd.shouldLabel).toBe(false);
    expect(fixAtEnd.reason).toBe('fix-verdict');

    const fixBeforeOtherAxisMerge = evaluateCampaignVerdicts(
      facts([
        makeComment('spec', 'MERGE', { id: 10 }),
        makeComment('spec', 'FIX', { id: 20 }),
        makeComment('standards', 'MERGE', { id: 30 }),
      ]),
    );
    expect(fixBeforeOtherAxisMerge.shouldLabel).toBe(false);
    expect(fixBeforeOtherAxisMerge.reason).toBe('fix-verdict');

    const unsortedComments = evaluateCampaignVerdicts(
      facts([
        makeComment('spec', 'FIX', { id: 30 }),
        makeComment('standards', 'MERGE', { id: 20 }),
        makeComment('spec', 'MERGE', { id: 10 }),
      ]),
    );
    expect(unsortedComments.shouldLabel).toBe(false);
    expect(unsortedComments.reason).toBe('fix-verdict');
  });

  test('allows a later MERGE on the same axis to supersede an earlier FIX on the same SHA', () => {
    const superseded = evaluateCampaignVerdicts(
      facts([
        makeComment('spec', 'MERGE', { id: 10 }),
        makeComment('standards', 'FIX', { id: 20 }),
        makeComment('standards', 'MERGE', { id: 30 }),
      ]),
    );
    expect(superseded.shouldLabel).toBe(true);
    expect(superseded.reason).toBe('ready');
  });

  test('rejects missing axis, draft PR, closed PR, non-main base, fork PR, and already-labeled PR', () => {
    const specMerge = makeComment('spec', 'MERGE', { id: 10 });
    const standardsMerge = makeComment('standards', 'MERGE', { id: 20 });
    const bothMerge = [specMerge, standardsMerge];

    const missingStandards = evaluateCampaignVerdicts(facts([specMerge]));
    expect(missingStandards.shouldLabel).toBe(false);
    expect(missingStandards.reason).toBe('missing-verdict');

    const expectedReasons: Array<{ overrides: Partial<CampaignPullState>; reason: CampaignDecisionReason }> = [
      { overrides: { isDraft: true }, reason: 'draft' },
      { overrides: { state: 'closed' }, reason: 'not-open' },
      { overrides: { baseRef: 'release/v1' }, reason: 'wrong-base' },
      { overrides: { headRepoFullName: 'attacker/pyric' }, reason: 'fork-pull-request' },
      { overrides: { labels: [QUEUE_LABEL] }, reason: 'already-labeled' },
    ];
    for (const item of expectedReasons) {
      const decision = evaluateCampaignVerdicts(facts(bothMerge, item.overrides));
      expect(decision.shouldLabel).toBe(false);
      expect(decision.reason).toBe(item.reason);
    }
  });
});

describe('reconcileCampaignVerdicts', () => {
  test('paginates PR comments across pages and posts merge-queue label when both axes approve', () => {
    const ghCalls: string[][] = [];
    const logs: string[] = [];
    const page1 = Array.from({ length: 100 }, (_, index) => ({
      id: index + 1,
      author_association: 'MEMBER',
      body: index === 0 ? makeComment('spec', 'MERGE', { id: 1 }).body : `Note ${index}`,
    }));
    const page2 = [
      {
        id: 101,
        author_association: 'OWNER',
        body: makeComment('standards', 'MERGE', { id: 101 }).body,
      },
    ];

    const io: CampaignVerdictsIo = {
      repo: 'davideast/pyric',
      gh: (args) => {
        ghCalls.push(args);
        const endpoint = args[1] ?? '';
        if (endpoint === 'repos/davideast/pyric/pulls/2669') {
          return JSON.stringify({
            number: 2669,
            state: 'open',
            draft: false,
            base: { ref: 'main' },
            head: { sha: HEAD_SHA, repo: { full_name: 'davideast/pyric' } },
            labels: [],
          });
        }
        if (endpoint === 'repos/davideast/pyric/issues/2669/comments?per_page=100') {
          return JSON.stringify(page1);
        }
        if (endpoint === 'repos/davideast/pyric/issues/2669/comments?per_page=100&page=2') {
          return JSON.stringify(page2);
        }
        if (args[0] === 'api' && args[1] === '-X' && args[2] === 'POST') {
          return '[]';
        }
        throw new Error(`Unexpected gh call: ${args.join(' ')}`);
      },
      log: (text) => logs.push(text),
    };

    const decision = reconcileCampaignVerdicts(io, 2669);
    expect(decision.shouldLabel).toBe(true);
    expect(decision.reason).toBe('ready');
    expect(ghCalls).toContainEqual([
      'api',
      '-X',
      'POST',
      'repos/davideast/pyric/issues/2669/labels',
      '-f',
      `labels[]=${QUEUE_LABEL}`,
    ]);
    expect(logs.some((line) => line.includes(`Added ${QUEUE_LABEL}`))).toBe(true);
  });

  test('fails closed if comment history exceeds maxCommentPages so a later FIX cannot be missed', () => {
    const fullPage = Array.from({ length: 100 }, (_, index) => ({
      id: index + 1,
      author_association: 'OWNER',
      body: 'discussion',
    }));
    const io: CampaignVerdictsIo = {
      repo: 'davideast/pyric',
      gh: (args) => {
        const endpoint = args[1] ?? '';
        if (endpoint === 'repos/davideast/pyric/pulls/2669') {
          return JSON.stringify({
            number: 2669,
            state: 'open',
            draft: false,
            base: { ref: 'main' },
            head: { sha: HEAD_SHA, repo: { full_name: 'davideast/pyric' } },
            labels: [],
          });
        }
        return JSON.stringify(fullPage);
      },
      log: () => {},
    };

    expect(() => reconcileCampaignVerdicts(io, 2669, { maxCommentPages: 2 })).toThrow(/truncated comment history/);
  });

  test('CLI entrypoint evaluates env vars and skips labeling when dry-run or FIX is present', () => {
    const root = mkdtempSync(join(tmpdir(), 'campaign-verdicts-cli-'));
    const scriptPath = resolve(import.meta.dir, 'campaign-verdicts.ts');
    try {
      const logFile = join(root, 'gh.log');
      const fakeGh = join(root, 'gh');
      const specComment = makeComment('spec', 'MERGE', { id: 1 }).body;
      const standardsFix = makeComment('standards', 'FIX', { id: 2 }).body;
      const pullJson = JSON.stringify({
        number: 55,
        state: 'open',
        draft: false,
        base: { ref: 'main' },
        head: { sha: HEAD_SHA, repo: { full_name: 'owner/repo' } },
        labels: [],
      });
      const commentsJson = JSON.stringify([
        { id: 1, author_association: 'OWNER', body: specComment },
        { id: 2, author_association: 'COLLABORATOR', body: standardsFix },
      ]);
      writeFileSync(join(root, 'pull.json'), pullJson);
      writeFileSync(join(root, 'comments.json'), commentsJson);
      writeFileSync(
        fakeGh,
        [
          '#!/usr/bin/env sh',
          'printf "%s\\n" "$*" >> "$GH_CALL_LOG"',
          'case "$*" in',
          '  *"pulls/55") cat "$FAKE_ROOT/pull.json" ;;',
          '  *"issues/55/comments"*) cat "$FAKE_ROOT/comments.json" ;;',
          '  *) exit 1 ;;',
          'esac',
        ].join('\n'),
      );
      chmodSync(fakeGh, 0o755);

      const out = spawnSync(process.execPath, [scriptPath], {
        encoding: 'utf8',
        env: {
          ...process.env,
          PATH: `${root}:${process.env.PATH ?? ''}`,
          GITHUB_REPOSITORY: 'owner/repo',
          PR_NUMBER: '55',
          GH_CALL_LOG: logFile,
          FAKE_ROOT: root,
        },
      });

      expect(out.status).toBe(0);
      const calls = readFileSync(logFile, 'utf8').trim().split('\n');
      expect(calls).toEqual([
        'api repos/owner/repo/pulls/55',
        'api repos/owner/repo/issues/55/comments?per_page=100',
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('campaign-verdicts.yml workflow security and triggers', () => {
  const workflowPath = resolve(import.meta.dir, '../../.github/workflows/campaign-verdicts.yml');

  test('triggers on issue_comment and pull_request synchronize, pins checkout to main, uses least privilege, and never interpolates ${{ }} in run:', () => {
    const raw = readFileSync(workflowPath, 'utf8');
    const parsed = Bun.YAML.parse(raw) as {
      on?: {
        issue_comment?: { types?: string[] };
        pull_request?: { types?: string[] };
      };
      permissions?: Record<string, string>;
      jobs?: Record<
        string,
        {
          if?: string;
          permissions?: Record<string, string>;
          steps?: Array<{
            uses?: string;
            with?: Record<string, unknown>;
            env?: Record<string, string>;
            run?: string;
          }>;
        }
      >;
    };

    expect(parsed.on?.issue_comment?.types).toContain('created');
    expect(parsed.on?.pull_request?.types).toContain('synchronize');
    expect(parsed.permissions).toEqual({ contents: 'read' });

    const jobs = Object.values(parsed.jobs ?? {});
    expect(jobs).toHaveLength(1);
    const job = jobs[0];
    expect(job?.permissions).toEqual({
      contents: 'read',
      issues: 'write',
      'pull-requests': 'write',
    });

    const checkoutStep = job?.steps?.find((step) => step.uses?.startsWith('actions/checkout@'));
    expect(checkoutStep?.uses).toBe('actions/checkout@v4');
    expect(checkoutStep?.with?.ref).toBe('main');
    expect(checkoutStep?.with?.['persist-credentials']).toBe(false);

    for (const step of job?.steps ?? []) {
      if (step.run !== undefined) {
        expect(step.run).not.toContain('${{');
      }
    }

    const buildWorkflow = readFileSync(resolve(import.meta.dir, '../../.github/workflows/build.yml'), 'utf8');
    expect(buildWorkflow).toContain('scripts/ci/campaign-verdict.test.ts');
    expect(buildWorkflow).toContain('scripts/ci/campaign-verdicts.test.ts');
  });
});

function walkFiles(dir: string): string[] {
  const results: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      results.push(...walkFiles(full));
    } else {
      results.push(full);
    }
  }
  return results.sort();
}

describe('advisor-campaign skill integrity and hygiene', () => {
  const repoRoot = resolve(import.meta.dir, '../..');
  const skillRoot = resolve(repoRoot, '.agents/skills/advisor-campaign');

  test('ships SKILL.md, templates, and references within <= 600 lines, plain ASCII, valid links, and zero leakage', () => {
    const requiredSkillFiles = [
      'SKILL.md',
      'references/code-review.md',
      'references/hygiene.md',
      'references/implement.md',
      'references/tdd-mocking.md',
      'references/tdd-tests.md',
      'references/tdd.md',
      'templates/builder-brief.md',
      'templates/pr-body-checklist.md',
      'templates/round-2-fix-brief.md',
      'templates/spec-reviewer-brief.md',
      'templates/standards-reviewer-brief.md',
    ];
    for (const rel of requiredSkillFiles) {
      expect(existsSync(join(skillRoot, rel))).toBe(true);
    }

    const auditedFiles = [
      ...walkFiles(skillRoot),
      resolve(repoRoot, '.github/workflows/campaign-verdicts.yml'),
      resolve(repoRoot, 'scripts/ci/campaign-verdict.ts'),
      resolve(repoRoot, 'scripts/ci/campaign-verdict.test.ts'),
      resolve(repoRoot, 'scripts/ci/campaign-verdicts.ts'),
      resolve(repoRoot, 'scripts/ci/campaign-verdicts.test.ts'),
    ];

    const asciiPattern = /^[\x00-\x7f]*$/;
    for (const file of auditedFiles) {
      const content = readFileSync(file, 'utf8');
      const lines = content.split('\n').length;
      expect({ file, withinLimit: lines <= 600 }).toEqual({ file, withinLimit: true });
      expect({ file, plainAscii: asciiPattern.test(content) }).toEqual({ file, plainAscii: true });
    }

    // Check relative Markdown links and generic path/session leakage invariants.
    const forbiddenLeakage =
      /\/Users\/|\/home\/|~\/\.|\.iam\.gserviceaccount\.com|\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i;
    for (const file of walkFiles(skillRoot)) {
      const content = readFileSync(file, 'utf8');
      expect(forbiddenLeakage.test(content)).toBe(false);
      for (const match of content.matchAll(/\[[^\]]+\]\(([^)#\s]+)(?:#[^)]*)?\)/g)) {
        const linkTarget = match[1] ?? '';
        if (linkTarget.startsWith('http://') || linkTarget.startsWith('https://')) continue;
        const resolved = resolve(dirname(file), linkTarget);
        expect({ file, linkTarget, exists: existsSync(resolved) }).toEqual({
          file,
          linkTarget,
          exists: true,
        });
      }
    }

    const specTemplate = readFileSync(join(skillRoot, 'templates/spec-reviewer-brief.md'), 'utf8');
    const standardsTemplate = readFileSync(
      join(skillRoot, 'templates/standards-reviewer-brief.md'),
      'utf8',
    );
    expect(specTemplate).toContain('<!-- campaign-verdict axis=spec verdict=MERGE|FIX sha=<40-char head sha> -->');
    expect(standardsTemplate).toContain(
      '<!-- campaign-verdict axis=standards verdict=MERGE|FIX sha=<40-char head sha> -->',
    );
  });
});


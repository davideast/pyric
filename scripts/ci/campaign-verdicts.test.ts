import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { formatVerdictComment } from './campaign-verdict-markers.ts';
import {
  TRUSTED_AUTHOR_ASSOCIATIONS,
  detectTrustedTriggerVerdict,
  evaluateCampaignVerdicts,
  reconcileCampaignVerdicts,
  type CampaignComment,
  type CampaignDecisionAction,
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

function isoAtMinute(minute: number): string {
  const padded = String(minute).padStart(2, '0');
  return `2026-11-17T03:${padded}:00Z`;
}

function makeComment(
  id: number,
  axis: 'spec' | 'standards',
  verdict: 'MERGE' | 'FIX',
  options: {
    sha?: string;
    authorAssociation?: string;
    userType?: string;
    updatedAt?: string;
    summary?: string;
  } = {},
): CampaignComment {
  return {
    id,
    authorAssociation: options.authorAssociation ?? 'COLLABORATOR',
    userType: options.userType ?? 'User',
    updatedAt: options.updatedAt ?? isoAtMinute(id),
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
  triggerHadTrustedVerdict = false,
): CampaignVerdictFacts {
  return {
    repo: 'davideast/pyric',
    pull: basePull(pullOverrides),
    comments,
    triggerHadTrustedVerdict,
  };
}

describe('evaluateCampaignVerdicts', () => {
  test('adds merge-queue when open, non-draft, targeting main, with trusted human MERGE on both axes', () => {
    expect([...TRUSTED_AUTHOR_ASSOCIATIONS].sort()).toEqual(['COLLABORATOR', 'MEMBER', 'OWNER']);

    const decision: CampaignVerdictDecision = evaluateCampaignVerdicts(
      facts([
        makeComment(10, 'spec', 'MERGE', { authorAssociation: 'OWNER' }),
        makeComment(20, 'standards', 'MERGE', { authorAssociation: 'MEMBER' }),
      ]),
    );

    expect(decision.action).toBe('add-label');
    expect(decision.reason).toBe('ready');
    expect(decision.hasTrustedVerdictHistory).toBe(true);
    expect(decision.latestByAxis).toEqual({ spec: 'MERGE', standards: 'MERGE' });
  });

  test('ignores untrusted author associations and Bot accounts for MERGE, FIX, and malformed markers', () => {
    for (const association of ['CONTRIBUTOR', 'FIRST_TIME_CONTRIBUTOR', 'FIRST_TIMER', 'MANNEQUIN', 'NONE', '']) {
      const mergeAttempt = evaluateCampaignVerdicts(
        facts([
          makeComment(10, 'spec', 'MERGE', { authorAssociation: 'COLLABORATOR' }),
          makeComment(20, 'standards', 'MERGE', { authorAssociation: association }),
        ]),
      );
      expect(mergeAttempt.action).toBe('noop');
      expect(mergeAttempt.reason).toBe('missing-verdict');
      expect(mergeAttempt.untrustedVerdictCount).toBe(1);
    }

    // Even if user.type is Bot with COLLABORATOR/MEMBER/OWNER association, it cannot approve or poison.
    const botMerge = evaluateCampaignVerdicts(
      facts([
        makeComment(10, 'spec', 'MERGE', { authorAssociation: 'OWNER' }),
        makeComment(20, 'standards', 'MERGE', { authorAssociation: 'COLLABORATOR', userType: 'Bot' }),
      ]),
    );
    expect(botMerge.action).toBe('noop');
    expect(botMerge.reason).toBe('missing-verdict');
    expect(botMerge.untrustedVerdictCount).toBe(1);

    const untrustedAndBotPoison = evaluateCampaignVerdicts(
      facts([
        makeComment(10, 'spec', 'MERGE', { authorAssociation: 'OWNER' }),
        makeComment(20, 'standards', 'MERGE', { authorAssociation: 'COLLABORATOR' }),
        makeComment(30, 'spec', 'FIX', { authorAssociation: 'NONE' }),
        makeComment(35, 'standards', 'FIX', { authorAssociation: 'MEMBER', userType: 'Bot' }),
        {
          id: 40,
          authorAssociation: 'CONTRIBUTOR',
          userType: 'User',
          updatedAt: isoAtMinute(40),
          body: '<!-- campaign-verdict broken -->',
        },
      ]),
    );
    expect(untrustedAndBotPoison.action).toBe('add-label');
    expect(untrustedAndBotPoison.reason).toBe('ready');
    expect(untrustedAndBotPoison.untrustedVerdictCount).toBe(3);
  });

  test('orders verdicts by updated_at (so an older comment edited to FIX overrides an earlier MERGE) and lets FIX win within one comment', () => {
    // Comment #10 (created earlier) is edited AFTER #20 to flip spec -> FIX.
    const editedOlderToFix = evaluateCampaignVerdicts(
      facts([
        makeComment(10, 'spec', 'FIX', { updatedAt: '2026-11-17T03:30:00Z' }),
        makeComment(20, 'spec', 'MERGE', { updatedAt: '2026-11-17T03:10:00Z' }),
        makeComment(25, 'standards', 'MERGE', { updatedAt: '2026-11-17T03:15:00Z' }),
      ]),
    );
    expect(editedOlderToFix.action).toBe('noop');
    expect(editedOlderToFix.reason).toBe('fix-verdict');

    // Single comment holding both FIX and MERGE for spec (in either order) resolves to FIX.
    const sameCommentConflict = evaluateCampaignVerdicts(
      facts([
        {
          id: 10,
          authorAssociation: 'OWNER',
          userType: 'User',
          updatedAt: isoAtMinute(10),
          body: [
            `<!-- campaign-verdict axis=spec verdict=FIX sha=${HEAD_SHA} -->`,
            `<!-- campaign-verdict axis=spec verdict=MERGE sha=${HEAD_SHA} -->`,
            `<!-- campaign-verdict axis=standards verdict=MERGE sha=${HEAD_SHA} -->`,
          ].join('\n'),
        },
      ]),
    );
    expect(sameCommentConflict.action).toBe('noop');
    expect(sameCommentConflict.reason).toBe('fix-verdict');
    expect(sameCommentConflict.latestByAxis.spec).toBe('FIX');

    // A malformed marker from a trusted human fails closed rather than dropping a potential FIX.
    const malformedTrusted = evaluateCampaignVerdicts(
      facts([
        makeComment(10, 'spec', 'MERGE'),
        makeComment(20, 'standards', 'MERGE'),
        {
          id: 30,
          authorAssociation: 'MEMBER',
          userType: 'User',
          updatedAt: isoAtMinute(30),
          body: '<!-- campaign-verdict axis=spec verdict=FIX sha=1aa55782a -->',
        },
      ]),
    );
    expect(malformedTrusted.action).toBe('noop');
    expect(malformedTrusted.reason).toBe('malformed-verdict');
  });

  test('removes merge-queue when a campaign-labeled PR receives a new push, FIX, comment edit/delete, draft, or base change, while leaving manual labels untouched', () => {
    const staleApproved = [
      makeComment(10, 'spec', 'MERGE', { sha: STALE_SHA }),
      makeComment(20, 'standards', 'MERGE', { sha: STALE_SHA }),
    ];
    // Unreviewed push (headSha is HEAD_SHA, verdicts are on STALE_SHA) while merge-queue is present.
    const pushedUnreviewed = evaluateCampaignVerdicts(
      facts(staleApproved, { labels: [QUEUE_LABEL] }),
    );
    expect(pushedUnreviewed.action).toBe('remove-label');
    expect(pushedUnreviewed.reason).toBe('missing-verdict');
    expect(pushedUnreviewed.staleVerdictCount).toBe(2);

    // FIX posted after MERGE while merge-queue is present.
    const fixAfterLabel = evaluateCampaignVerdicts(
      facts(
        [
          makeComment(10, 'spec', 'MERGE'),
          makeComment(20, 'standards', 'MERGE'),
          makeComment(30, 'standards', 'FIX'),
        ],
        { labels: [QUEUE_LABEL] },
      ),
    );
    expect(fixAfterLabel.action).toBe('remove-label');
    expect(fixAfterLabel.reason).toBe('fix-verdict');

    // Sole verdict comment deleted (0 live verdict comments remain, triggerHadTrustedVerdict = true).
    const deletedSoleVerdict = evaluateCampaignVerdicts(
      facts([], { labels: [QUEUE_LABEL] }, true),
    );
    expect(deletedSoleVerdict.action).toBe('remove-label');
    expect(deletedSoleVerdict.reason).toBe('missing-verdict');

    // Converted to draft or retargeted base while merge-queue is present on a campaign PR.
    const validBoth = [
      makeComment(10, 'spec', 'MERGE'),
      makeComment(20, 'standards', 'MERGE'),
    ];
    const convertedToDraft = evaluateCampaignVerdicts(
      facts(validBoth, { isDraft: true, labels: [QUEUE_LABEL] }),
    );
    expect(convertedToDraft.action).toBe('remove-label');
    expect(convertedToDraft.reason).toBe('draft');

    const retargetedBase = evaluateCampaignVerdicts(
      facts(validBoth, { baseRef: 'release/v1', labels: [QUEUE_LABEL] }),
    );
    expect(retargetedBase.action).toBe('remove-label');
    expect(retargetedBase.reason).toBe('wrong-base');

    // Already labeled and still valid -> idempotent noop.
    const stillValid = evaluateCampaignVerdicts(
      facts(validBoth, { labels: [QUEUE_LABEL] }),
    );
    expect(stillValid.action).toBe('noop');
    expect(stillValid.reason).toBe('already-labeled');

    // Manually labeled non-campaign PR (zero verdict history) stays untouched across events!
    const manualLabeledPush = evaluateCampaignVerdicts(
      facts([], { labels: [QUEUE_LABEL] }, false),
    );
    expect(manualLabeledPush.action).toBe('noop');
    expect(manualLabeledPush.hasTrustedVerdictHistory).toBe(false);
  });

  test('rejects missing axis, draft, closed, non-main base, and fork PR when unlabeled', () => {
    const specMerge = makeComment(10, 'spec', 'MERGE');
    const standardsMerge = makeComment(20, 'standards', 'MERGE');
    const bothMerge = [specMerge, standardsMerge];

    expect(evaluateCampaignVerdicts(facts([specMerge]))).toMatchObject({
      action: 'noop',
      reason: 'missing-verdict',
    });

    const cases: Array<{
      overrides: Partial<CampaignPullState>;
      action: CampaignDecisionAction;
      reason: CampaignDecisionReason;
    }> = [
      { overrides: { isDraft: true }, action: 'noop', reason: 'draft' },
      { overrides: { state: 'closed' }, action: 'noop', reason: 'not-open' },
      { overrides: { baseRef: 'release/v1' }, action: 'noop', reason: 'wrong-base' },
      { overrides: { headRepoFullName: 'attacker/pyric' }, action: 'noop', reason: 'fork-pull-request' },
    ];
    for (const item of cases) {
      const decision = evaluateCampaignVerdicts(facts(bothMerge, item.overrides));
      expect(decision.action).toBe(item.action);
      expect(decision.reason).toBe(item.reason);
    }
  });
});

function openPullJson(
  options: { number?: number; repo?: string; labels?: readonly string[] } = {},
): string {
  const number = options.number ?? 2669;
  const repo = options.repo ?? 'davideast/pyric';
  const labels = (options.labels ?? []).map((name) => ({ name }));
  return JSON.stringify({
    number,
    state: 'open',
    draft: false,
    base: { ref: 'main' },
    head: { sha: HEAD_SHA, repo: { full_name: repo } },
    labels,
  });
}

describe('detectTrustedTriggerVerdict and reconcileCampaignVerdicts', () => {
  test('detectTrustedTriggerVerdict recognizes edited/deleted trusted human verdict comments and ignores bots or outsiders', () => {
    const markerLine = `<!-- campaign-verdict axis=spec verdict=MERGE sha=${HEAD_SHA} -->`;
    expect(
      detectTrustedTriggerVerdict('issue_comment', {
        action: 'deleted',
        comment: {
          author_association: 'OWNER',
          user: { type: 'User' },
          body: markerLine,
        },
      }),
    ).toBe(true);

    expect(
      detectTrustedTriggerVerdict('issue_comment', {
        action: 'edited',
        comment: {
          author_association: 'COLLABORATOR',
          user: { type: 'User' },
          body: 'Removed marker.',
        },
        changes: { body: { from: markerLine } },
      }),
    ).toBe(true);

    expect(
      detectTrustedTriggerVerdict('issue_comment', {
        action: 'deleted',
        comment: {
          author_association: 'COLLABORATOR',
          user: { type: 'Bot' },
          body: markerLine,
        },
      }),
    ).toBe(false);

    expect(
      detectTrustedTriggerVerdict('issue_comment', {
        action: 'deleted',
        comment: {
          author_association: 'NONE',
          user: { type: 'User' },
          body: markerLine,
        },
      }),
    ).toBe(false);
  });

  test('paginates PR comments, adds merge-queue, and dispatches merge-queue.yml when ready', () => {
    const ghCalls: string[][] = [];
    const logs: string[] = [];
    const specCommentBody = makeComment(1, 'spec', 'MERGE').body;
    const page1 = Array.from({ length: 100 }, (_, index) => {
      let body = `Note ${index}`;
      if (index === 0) {
        body = specCommentBody;
      }
      return {
        id: index + 1,
        author_association: 'MEMBER',
        user: { type: 'User' },
        updated_at: isoAtMinute(1),
        body,
      };
    });
    const page2 = [
      {
        id: 101,
        author_association: 'OWNER',
        user: { type: 'User' },
        updated_at: isoAtMinute(2),
        body: makeComment(101, 'standards', 'MERGE').body,
      },
    ];

    const io: CampaignVerdictsIo = {
      repo: 'davideast/pyric',
      gh: (args) => {
        ghCalls.push(args);
        const endpoint = args[1] ?? '';
        if (endpoint === 'repos/davideast/pyric/pulls/2669') {
          return openPullJson();
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
        if (args[0] === 'workflow' && args[1] === 'run') {
          return '';
        }
        throw new Error(`Unexpected gh call: ${args.join(' ')}`);
      },
      log: (text) => logs.push(text),
    };

    const decision = reconcileCampaignVerdicts(io, 2669);
    expect(decision.action).toBe('add-label');
    expect(ghCalls).toContainEqual([
      'api',
      '-X',
      'POST',
      'repos/davideast/pyric/issues/2669/labels',
      '-f',
      `labels[]=${QUEUE_LABEL}`,
    ]);
    expect(ghCalls).toContainEqual([
      'workflow',
      'run',
      'merge-queue.yml',
      '--repo',
      'davideast/pyric',
      '--ref',
      'main',
      '-f',
      'dry_run=false',
    ]);
    expect(logs.some((line) => line.includes(`Added ${QUEUE_LABEL}`))).toBe(true);
  });

  test('removes merge-queue and dispatches merge-queue.yml when an unreviewed push invalidates verdicts', () => {
    const ghCalls: string[][] = [];
    const io: CampaignVerdictsIo = {
      repo: 'davideast/pyric',
      gh: (args) => {
        ghCalls.push(args);
        const endpoint = args[1] ?? '';
        if (endpoint === 'repos/davideast/pyric/pulls/2669') {
          return openPullJson({ labels: [QUEUE_LABEL] });
        }
        if (endpoint === 'repos/davideast/pyric/issues/2669/comments?per_page=100') {
          return JSON.stringify([
            {
              id: 1,
              author_association: 'OWNER',
              user: { type: 'User' },
              updated_at: isoAtMinute(1),
              body: makeComment(1, 'spec', 'MERGE', { sha: STALE_SHA }).body,
            },
            {
              id: 2,
              author_association: 'COLLABORATOR',
              user: { type: 'User' },
              updated_at: isoAtMinute(2),
              body: makeComment(2, 'standards', 'MERGE', { sha: STALE_SHA }).body,
            },
          ]);
        }
        if (args[0] === 'api' && args[1] === '-X' && args[2] === 'DELETE') {
          return '';
        }
        if (args[0] === 'workflow' && args[1] === 'run') {
          return '';
        }
        throw new Error(`Unexpected gh call: ${args.join(' ')}`);
      },
      log: () => {},
    };

    const decision = reconcileCampaignVerdicts(io, 2669);
    expect(decision.action).toBe('remove-label');
    expect(decision.reason).toBe('missing-verdict');
    expect(ghCalls).toContainEqual([
      'api',
      '-X',
      'DELETE',
      `repos/davideast/pyric/issues/2669/labels/${QUEUE_LABEL}`,
    ]);
    expect(ghCalls).toContainEqual([
      'workflow',
      'run',
      'merge-queue.yml',
      '--repo',
      'davideast/pyric',
      '--ref',
      'main',
      '-f',
      'dry_run=false',
    ]);
  });

  test('fails closed if comment history exceeds maxCommentPages so a later FIX cannot be missed', () => {
    const fullPage = Array.from({ length: 100 }, (_, index) => ({
      id: index + 1,
      author_association: 'OWNER',
      user: { type: 'User' },
      updated_at: isoAtMinute(1),
      body: 'discussion',
    }));
    const io: CampaignVerdictsIo = {
      repo: 'davideast/pyric',
      gh: (args) => {
        const endpoint = args[1] ?? '';
        if (endpoint === 'repos/davideast/pyric/pulls/2669') {
          return openPullJson();
        }
        return JSON.stringify(fullPage);
      },
      log: () => {},
    };

    expect(() => reconcileCampaignVerdicts(io, 2669, { maxCommentPages: 2 })).toThrow(
      /truncated comment history/,
    );
  });

  test('CLI entrypoint reads GITHUB_EVENT_PATH and removes merge-queue when sole verdict comment is deleted', () => {
    const root = mkdtempSync(join(tmpdir(), 'campaign-verdicts-cli-'));
    const scriptPath = resolve(import.meta.dir, 'campaign-verdicts.ts');
    try {
      const logFile = join(root, 'gh.log');
      const fakeGh = join(root, 'gh');
      const eventFile = join(root, 'event.json');
      writeFileSync(
        eventFile,
        JSON.stringify({
          action: 'deleted',
          comment: {
            author_association: 'OWNER',
            user: { type: 'User' },
            body: makeComment(1, 'spec', 'MERGE').body,
          },
        }),
      );
      writeFileSync(
        join(root, 'pull.json'),
        openPullJson({ number: 55, repo: 'owner/repo', labels: [QUEUE_LABEL] }),
      );
      writeFileSync(join(root, 'comments.json'), '[]');
      writeFileSync(
        fakeGh,
        [
          '#!/usr/bin/env sh',
          'printf "%s\\n" "$*" >> "$GH_CALL_LOG"',
          'case "$*" in',
          '  *"pulls/55") cat "$FAKE_ROOT/pull.json" ;;',
          '  *"issues/55/comments"*) cat "$FAKE_ROOT/comments.json" ;;',
          '  *"DELETE repos/owner/repo/issues/55/labels/merge-queue") printf "" ;;',
          '  "workflow run merge-queue.yml --repo owner/repo --ref main -f dry_run=false") printf "" ;;',
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
          GITHUB_EVENT_NAME: 'issue_comment',
          GITHUB_EVENT_PATH: eventFile,
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
        `api -X DELETE repos/owner/repo/issues/55/labels/${QUEUE_LABEL}`,
        'workflow run merge-queue.yml --repo owner/repo --ref main -f dry_run=false',
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

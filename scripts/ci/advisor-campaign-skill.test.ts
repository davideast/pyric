import { describe, expect, test } from 'bun:test';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

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
      resolve(repoRoot, 'scripts/ci/advisor-campaign-skill.test.ts'),
      resolve(repoRoot, 'scripts/ci/campaign-verdict-markers.ts'),
      resolve(repoRoot, 'scripts/ci/campaign-verdict-markers.test.ts'),
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
    expect(specTemplate).toContain(
      '<!-- campaign-verdict axis=spec verdict=MERGE|FIX sha=<40-char head sha> -->',
    );
    expect(standardsTemplate).toContain(
      '<!-- campaign-verdict axis=standards verdict=MERGE|FIX sha=<40-char head sha> -->',
    );
  });

  test('campaign-verdicts.yml triggers on comment + PR lifecycle events, pins checkout to main, enforces if: guards, uses least privilege, and never interpolates ${{ }} in run:', () => {
    const workflowPath = resolve(repoRoot, '.github/workflows/campaign-verdicts.yml');
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

    expect(parsed.on?.issue_comment?.types).toEqual(['created', 'edited', 'deleted']);
    expect(parsed.on?.pull_request?.types).toEqual([
      'synchronize',
      'ready_for_review',
      'reopened',
      'converted_to_draft',
      'edited',
    ]);
    expect(parsed.permissions).toEqual({ contents: 'read' });

    const jobs = Object.values(parsed.jobs ?? {});
    expect(jobs).toHaveLength(1);
    const job = jobs[0];
    expect(job?.permissions).toEqual({
      actions: 'write',
      contents: 'read',
      issues: 'write',
      'pull-requests': 'write',
    });

    const jobIf = job?.if ?? '';
    expect(jobIf).toContain('github.event.issue.pull_request != null');
    expect(jobIf).toContain("github.event.comment.user.type != 'Bot'");
    expect(jobIf).toContain("github.event.comment.author_association == 'OWNER'");
    expect(jobIf).toContain("github.event.comment.author_association == 'MEMBER'");
    expect(jobIf).toContain("github.event.comment.author_association == 'COLLABORATOR'");
    expect(jobIf).toContain('github.event.pull_request.head.repo.full_name == github.repository');
    expect(jobIf).toContain("contains(github.event.pull_request.labels.*.name, 'merge-queue')");
    expect(jobIf).toContain("github.event.action != 'edited' || github.event.changes.base != null");

    const checkoutStep = job?.steps?.find((step) => step.uses?.startsWith('actions/checkout@'));
    expect(checkoutStep?.uses).toBe('actions/checkout@v4');
    expect(checkoutStep?.with?.ref).toBe('main');
    expect(checkoutStep?.with?.['persist-credentials']).toBe(false);

    for (const step of job?.steps ?? []) {
      if (step.run !== undefined) {
        expect(step.run).not.toContain('${{');
      }
      if (step.env !== undefined) {
        expect(Object.values(step.env).join('\n')).not.toContain('MERGE_QUEUE_TOKEN');
      }
    }

    const buildWorkflow = readFileSync(resolve(repoRoot, '.github/workflows/build.yml'), 'utf8');
    expect(buildWorkflow).toContain('scripts/ci/campaign-verdict-markers.test.ts');
    expect(buildWorkflow).toContain('scripts/ci/campaign-verdict.test.ts');
    expect(buildWorkflow).toContain('scripts/ci/campaign-verdicts.test.ts');
    expect(buildWorkflow).toContain('scripts/ci/advisor-campaign-skill.test.ts');
  });
});

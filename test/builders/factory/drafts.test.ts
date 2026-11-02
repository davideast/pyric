import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkDrafts, formatDrafts, parseDraft, validateDraft } from './drafts.ts';

const DIVERGENCE = `Title: Firestore: pyric allows a where on two fields, production asks for an index
Label: divergence

**pyric:** The query returns results.

**Production:** It fails with failed-precondition until an index exists. [Reference](https://firebase.google.com/docs/firestore/query-data/indexing)

**Who notices:** An app that ships without the index.

**Done when:**
- a scenario under test/apps/ refuses the query

Found by factory run 2026-11-01, item search-query. Repro: \`issue-drafts/repros/where-index/repro.mjs\`.
`;

const SUPPORT = `Title: Support getCountFromServer in pyric/firestore
Label: support

**Missing:** It throws "not implemented".

**In production:** It returns the count. [Reference](https://firebase.google.com/docs/firestore/query-data/aggregation-queries)

**Workaround:** none

**Done when:** a scenario under test/apps/ counts a collection

Found by factory run 2026-11-01, item library-count.
`;

const BUG = `Title: The dev server exits when a route imports pyric/storage
Label: bug

**What breaks:** next dev exits with code 1.

**Expected:** The route renders.

**Repro:** \`issue-drafts/repros/storage-route/repro.mjs\`: starts next dev and requests the route.

**Done when:** test/apps/next-storage covers the route

Found by factory run 2026-11-01, item image-upload.
`;

interface KindCase {
  label: string;
  title: string;
  wrongTitle: string;
  fields: Record<string, string>;
}

const LINK = '[Reference](https://firebase.google.com/docs)';

/** One valid draft per kind in AGENTS.md's table, with a title outside its pattern. */
const KIND_CASES: readonly KindCase[] = [
  { label: 'support', title: 'Support getCountFromServer in pyric/firestore', wrongTitle: 'Add getCountFromServer', fields: { Missing: 'It throws.', 'In production': `It counts. ${LINK}`, Workaround: 'none', 'Done when': 'a scenario counts' } },
  { label: 'divergence', title: 'Firestore: pyric allows X, production refuses it', wrongTitle: 'Firestore allows X', fields: { pyric: 'It allows X.', Production: `It refuses X. ${LINK}`, 'Who notices': 'Apps that ship X.', 'Done when': 'a scenario refuses X' } },
  { label: 'bug', title: 'The dev server exits when a route imports storage', wrongTitle: 'The dev server exits', fields: { 'What breaks': 'It exits.', Expected: 'It serves.', Repro: 'repro.mjs', 'Done when': 'a scenario serves it' } },
  { label: 'security', title: 'Security: rules state exposed to other origins', wrongTitle: 'Rules state exposed', fields: { Exposure: 'The state.', 'Who can reach it': 'Any page.', Fix: 'Check the origin.', 'Done when': 'a scenario refuses it' } },
  { label: 'flake', title: 'Red on main: app scenarios', wrongTitle: 'Scenarios are red', fields: { 'Fails how': 'A timeout.', Since: '#1789', Cause: 'Unknown.', 'Done when': 'ten runs pass' } },
  { label: 'documentation', title: 'Docs: firestore/indexes: names the wrong flag', wrongTitle: 'Docs: the wrong flag', fields: { Says: '--index.', 'Should say': '--indexes.', 'Done when': 'the page says --indexes' } },
  { label: 'plan', title: 'Plan: factory runs nightly', wrongTitle: 'Nightly factory', fields: { Goal: 'A run each night.', Steps: 'Timer, runner.', Decisions: 'Hours.', 'Done when': 'a week of runs' } },
  { label: 'lane:velocity', title: 'CI: cache the packed packages', wrongTitle: 'Cache the packed packages', fields: { Problem: 'Packing is slow.', Change: 'Cache it.', 'Done when': 'packing takes a minute' } },
];

function kindDraft(kind: KindCase, overrides: { title?: string; omit?: string } = {}): string {
  const fields = Object.entries(kind.fields).filter(([name]) => name !== overrides.omit);
  const body = fields.map(([name, text]) => `**${name}:** ${text}`).join('\n\n');
  return `Title: ${overrides.title ?? kind.title}\nLabel: ${kind.label}\n\n${body}\n\nFound by factory run night-1, item one.\n`;
}

function runWithDrafts(drafts: Record<string, string>): string {
  const runDir = mkdtempSync(join(tmpdir(), 'factory-drafts-'));
  mkdirSync(join(runDir, 'issue-drafts', 'repros'), { recursive: true });
  for (const [file, text] of Object.entries(drafts)) writeFileSync(join(runDir, 'issue-drafts', file), text);
  return runDir;
}

describe('validateDraft', () => {
  test('accepts a divergence, a missing API and a tooling bug in the standard shape', () => {
    expect(validateDraft(DIVERGENCE)).toEqual([]);
    expect(validateDraft(SUPPORT)).toEqual([]);
    expect(validateDraft(BUG)).toEqual([]);
  });

  test('reads a field that runs over several lines', () => {
    expect(parseDraft(DIVERGENCE).fields.get('Done when')).toBe('- a scenario under test/apps/ refuses the query');
  });

  test("refuses a title outside its kind's pattern", () => {
    const text = SUPPORT.replace('Title: Support getCountFromServer in pyric/firestore', 'Title: Add count queries');
    expect(validateDraft(text)).toEqual(['the title does not match "Support <API> in <package>"']);
  });

  test('refuses a missing or empty field, and a missing "Found by" line', () => {
    const text = DIVERGENCE.replace('**Who notices:** An app that ships without the index.', '**Who notices:**').replace(/^Found by.*$/m, '');
    const withoutProduction = text.replace(/^\*\*Production:\*\*.*$/m, '');
    expect(validateDraft(withoutProduction)).toEqual([
      'missing the **Production:** field',
      'the **Who notices:** field is empty',
      'missing the "Found by" line',
    ]);
  });

  test('takes exactly one known label', () => {
    expect(validateDraft(BUG.replace('Label: bug', 'Labels: bug, lane:reliability'))).toEqual(['takes one label, found 2: bug, lane:reliability']);
    expect(validateDraft(BUG.replace('Label: bug', 'Label: defect'))).toEqual(['unknown label "defect"']);
    expect(validateDraft(BUG.replace('Label: bug\n', ''))).toEqual(['missing the "Label:" line']);
  });

  describe.each(KIND_CASES.map((kind) => [kind.label, kind] as const))('the %s kind', (_label, kind) => {
    test('accepts a draft in its shape', () => {
      expect(validateDraft(kindDraft(kind))).toEqual([]);
    });

    test('refuses a title outside its pattern', () => {
      const errors = validateDraft(kindDraft(kind, { title: kind.wrongTitle }));
      expect(errors).toHaveLength(1);
      expect(errors[0]).toStartWith('the title does not match');
    });

    test('refuses each missing field', () => {
      for (const name of Object.keys(kind.fields)) {
        expect(validateDraft(kindDraft(kind, { omit: name }))).toEqual([`missing the **${name}:** field`]);
      }
    });
  });

  test('takes both flake title forms, and any lane label for a CI draft', () => {
    const [flake, ci] = [KIND_CASES[4], KIND_CASES[7]];
    if (flake === undefined || ci === undefined) throw new Error('missing kind case');
    expect(validateDraft(kindDraft(flake, { title: 'Flaky: supervisor heartbeat test' }))).toEqual([]);
    expect(validateDraft(kindDraft({ ...ci, label: 'lane:rules' }))).toEqual([]);
    expect(validateDraft(kindDraft({ ...ci, label: 'lane:' }))).toEqual(['unknown label "lane:"']);
  });

  test('needs a link to the evidence in a divergence and a missing API', () => {
    expect(validateDraft(DIVERGENCE.replace(/ \[Reference\]\(.*\)$/m, ''))).toEqual(['the **Production:** field has no link to its evidence']);
    expect(validateDraft(SUPPORT.replace(/ \[Reference\]\(.*\)$/m, ''))).toEqual(['the **In production:** field has no link to its evidence']);
  });

  test('ignores the indented Output block after the "Found by" line', () => {
    const output = '\nOutput:\n    Label: not a label\n    **Production:** not a field\n    exit 1\n';
    expect(validateDraft(`${DIVERGENCE}${output}`)).toEqual([]);
  });

  test('needs a title', () => {
    expect(validateDraft(BUG.replace(/^Title:.*$/m, ''))).toEqual(['missing the "Title:" line']);
  });
});

describe('checkDrafts', () => {
  test("lists the run's drafts by name, with what breaks each", () => {
    const runDir = runWithDrafts({ 'b-index.md': DIVERGENCE, 'a-count.md': SUPPORT.replace(/^Found by.*$/m, ''), 'notes.txt': 'not a draft' });
    const checks = checkDrafts(runDir);
    expect(checks.map((check) => check.file)).toEqual(['a-count.md', 'b-index.md']);
    expect(checks[0]?.errors).toEqual(['missing the "Found by" line']);
    expect(checks[1]?.errors).toEqual([]);
    const report = formatDrafts(join(runDir, 'issue-drafts'), checks);
    expect(report).toContain('invalid  a-count.md  Support getCountFromServer in pyric/firestore\n    missing the "Found by" line');
    expect(report).toContain('2 drafts in');
    expect(report).toContain(', 1 invalid');
  });

  test('finds no drafts in a run that has none', () => {
    const runDir = mkdtempSync(join(tmpdir(), 'factory-drafts-'));
    expect(checkDrafts(runDir)).toEqual([]);
    expect(formatDrafts('x', [])).toBe('no issue drafts in x');
  });
});

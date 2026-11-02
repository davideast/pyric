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

// The factory's UI rules on fixtures: each marked line of bad.tsx and bad.css
// breaks exactly the rules its marker names, and good.tsx and good.css break
// none once the overlay marker is honored. Runs the harness's own ast-grep.
import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { APPROVED_COMPONENTS, seedApprovedComponents } from './app-setup.ts';
import { scan } from './ast-grep.ts';
import type { ChangedLines } from './diff-lines.ts';
import { hostRunner } from './exec.ts';
import { harnessAstGrep } from './tools.ts';
import { hasOverlayMarker, newComponentViolations, readApproved, ruleViolations, UI_RULES_CONFIG } from './ui-gates.ts';

const FIXTURES = fileURLToPath(new URL('./fixtures/ui-rules', import.meta.url));
const AST_GREP = harnessAstGrep();
const MARKER = /expect: ([\w -]+?)\s*(?:\*\/|$)/;

/** Every line of each file counts as changed. */
function allChanged(files: readonly string[]): ChangedLines {
  return new Map(files.map((file) => {
    const count = readFileSync(join(FIXTURES, file), 'utf8').split('\n').length;
    return [file, new Set(Array.from({ length: count }, (_, index) => index + 1))];
  }));
}

/** `line rule` pairs the markers expect. */
function expected(file: string): string[] {
  return readFileSync(join(FIXTURES, file), 'utf8').split('\n').flatMap((text, index) => {
    const rules = MARKER.exec(text)?.[1]?.trim().split(/\s+/) ?? [];
    return rules.map((rule) => `${index + 1} ${rule}`);
  });
}

async function violations(files: readonly string[]) {
  const findings = await scan({ runner: hostRunner(FIXTURES), binary: AST_GREP, config: UI_RULES_CONFIG, cwd: FIXTURES, files });
  return ruleViolations(findings, allChanged(files), (file) => readFileSync(join(FIXTURES, file), 'utf8'));
}

describe('the factory UI rules', () => {
  for (const file of ['bad.tsx', 'bad.css']) {
    test(`${file}: each marked line breaks the rules it names, and no other line breaks any`, async () => {
      const found = (await violations([file])).map((violation) => `${violation.line} ${violation.rule}`);
      expect(found.sort()).toEqual(expected(file).sort());
    });
  }

  for (const file of ['good.tsx', 'good.css']) {
    test(`${file}: tokens, grid track templates, variants and marked overlays pass`, async () => {
      expect(await violations([file])).toEqual([]);
    });
  }

  test('a violation on a line that did not change does not count', async () => {
    const findings = await scan({ runner: hostRunner(FIXTURES), binary: AST_GREP, config: UI_RULES_CONFIG, cwd: FIXTURES, files: ['bad.tsx'] });
    const onlyLineTen: ChangedLines = new Map([['bad.tsx', new Set([10])]]);
    const found = ruleViolations(findings, onlyLineTen, () => '');
    expect(found.map((violation) => violation.rule)).toEqual(['factory-no-margin']);
  });
});

describe('the overlay marker', () => {
  test('counts on the line itself or the line above, and needs a reason', () => {
    const source = '<a />\n{/* ui-overlay: the stretched link */}\n<a className="absolute" />\n<b className="absolute" /> // ui-overlay:\n';
    expect(hasOverlayMarker(source, 3)).toBe(true);
    expect(hasOverlayMarker(source, 1)).toBe(false);
    expect(hasOverlayMarker(source, 4)).toBe(false);
  });
});

describe('new components/ui files', () => {
  test('fail unless approved-components.txt names them by path or file name', () => {
    const added = ['studio/src/components/ui/checkbox.tsx', 'studio/src/components/ui/alert.tsx', 'studio/src/components/media/row.tsx'];
    const found = newComponentViolations(added, new Set(['alert.tsx']));
    expect(found.map((violation) => violation.file)).toEqual(['studio/src/components/ui/checkbox.tsx']);
  });

  test('include files nested under components/ui', () => {
    const found = newComponentViolations(['studio/src/components/ui/nested/fancy-card.tsx'], new Set(['checkbox.tsx']));
    expect(found.map((violation) => violation.file)).toEqual(['studio/src/components/ui/nested/fancy-card.tsx']);
  });

  test('pass when the list setup seeded from the brief names them, and fail otherwise', () => {
    const brief = mkdtempSync(join(tmpdir(), 'factory-brief-'));
    writeFileSync(join(brief, APPROVED_COMPONENTS), '# from the design\ncheckbox.tsx\nalert.tsx\n');
    const approvedComponents = join(mkdtempSync(join(tmpdir(), 'factory-host-')), APPROVED_COMPONENTS);
    expect(seedApprovedComponents(brief, { approvedComponents })).toBe(true);
    const listed = 'studio/src/components/ui/checkbox.tsx';
    const unlisted = 'studio/src/components/ui/fancy-card.tsx';
    const found = newComponentViolations([listed, unlisted], readApproved(approvedComponents));
    expect(found.map((violation) => violation.file)).toEqual([unlisted]);
  });

  test('approve nothing when the brief has no list, and refuse a list that is a link', () => {
    const brief = mkdtempSync(join(tmpdir(), 'factory-brief-'));
    const approvedComponents = join(mkdtempSync(join(tmpdir(), 'factory-host-')), APPROVED_COMPONENTS);
    expect(seedApprovedComponents(brief, { approvedComponents })).toBe(false);
    expect(newComponentViolations(['studio/src/components/ui/checkbox.tsx'], readApproved(approvedComponents))).toHaveLength(1);
    symlinkSync('/etc/hostname', join(brief, APPROVED_COMPONENTS));
    expect(() => seedApprovedComponents(brief, { approvedComponents })).toThrow('it is a link');
    const dirBrief = mkdtempSync(join(tmpdir(), 'factory-brief-'));
    mkdirSync(join(dirBrief, APPROVED_COMPONENTS));
    expect(() => seedApprovedComponents(dirBrief, { approvedComponents })).toThrow('it is not a regular file');
  });

  test('tell a session to use an existing component, since it can’t write the approved list', () => {
    const [violation] = newComponentViolations(['studio/src/components/ui/checkbox.tsx'], new Set());
    expect(violation?.message).toBe('A new file in components/ui that the brief\'s approved list does not name. Use an existing component.');
    expect(violation?.message).not.toContain('run directory');
  });
});

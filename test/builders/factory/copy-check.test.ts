// The copy check: the rules one string at a time, then the extractors and the
// report on a fixture. The extractor half runs the harness's own ast-grep.
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { scan } from './ast-grep.ts';
import { copyProblems, DEFAULT_OVERRIDES_FILE, readOverrides, type CopyOverrides } from './copy-rules.ts';
import { hostRunner } from './exec.ts';
import { harnessAstGrep } from './tools.ts';
import { copyReport, copyStrings, COPY_RULES_CONFIG } from './ui-gates.ts';

const FIXTURES = fileURLToPath(new URL('./fixtures/ui-rules', import.meta.url));
const AST_GREP = harnessAstGrep();
const overrides: CopyOverrides = readOverrides(DEFAULT_OVERRIDES_FILE);

describe('copyProblems', () => {
  test('passes DESIGN.md\'s own examples', () => {
    expect(copyProblems('Create playlist', 'button', overrides)).toEqual([]);
    expect(copyProblems('Narrate again', 'button', overrides)).toEqual([]);
    expect(copyProblems('Import to my downloads', 'button', overrides)).toEqual([]);
    expect(copyProblems('Use the download action in Library or Playlists to save audio here.', 'empty-state', overrides)).toEqual([]);
    expect(copyProblems('Turn written structure into something that sounds natural read aloud.', 'description', overrides)).toEqual([]);
    expect(copyProblems('Locked. It stays until you unlock it.', 'text', overrides)).toEqual([]);
  });

  test('fails the "Never write" phrases, em dashes and ellipses in any string', () => {
    expect(copyProblems('Welcome back', 'text', overrides)).toEqual(['never write a welcome or greeting']);
    expect(copyProblems('Here you can manage your files', 'text', overrides)).toEqual(['never write "Here you can"', 'never write "Manage your"']);
    expect(copyProblems('Simply drop a file', 'text', overrides)).toEqual(['never write "simply"']);
    expect(copyProblems('Locked — it stays', 'text', overrides)).toEqual(['no em dashes']);
    expect(copyProblems('Generating music…', 'text', overrides)).toHaveLength(1);
    expect(copyProblems('Search downloads...', 'text', overrides)).toHaveLength(1);
  });

  test('fails a button that is title case or does not start with a verb', () => {
    expect(copyProblems('Start Narration', 'button', overrides)).toEqual(['button labels are sentence case; "Narration" is capitalized']);
    expect(copyProblems('Submit', 'button', overrides)[0]).toContain('"Submit" is not on the verb list');
    expect(copyProblems('Continue', 'button', overrides)[0]).toContain('not on the verb list');
    expect(copyProblems('Open Library', 'button', overrides)).toEqual([]);
  });

  test('the override file adds verbs and whole labels', () => {
    expect(copyProblems('Continue search', 'button', overrides)).toEqual([]);
    const more = { ...overrides, verbs: ['queue'] };
    expect(copyProblems('Queue narration', 'button', more)).toEqual([]);
  });

  test('limits descriptions and empty states to one line, and empty states to one sentence', () => {
    const long = 'This description goes on and on with many more words than any single line of a settings row should ever hold.';
    expect(copyProblems(long, 'description', overrides)[0]).toContain('at most 20 words');
    expect(copyProblems(long, 'text', overrides)).toEqual([]);
    expect(copyProblems('Nothing here yet. Save some audio.', 'empty-state', overrides)).toEqual(['2 sentences; an empty state is one sentence and one action']);
  });
});

describe('copyStrings on a fixture', () => {
  test('finds each string once, with its most specific kind, and reports every one', async () => {
    const lines = readFileSync(join(FIXTURES, 'copy.tsx'), 'utf8').split('\n').length;
    const changed = new Map([['copy.tsx', new Set(Array.from({ length: lines }, (_, index) => index + 1))]]);
    const findings = await scan({ runner: hostRunner(FIXTURES), binary: AST_GREP, config: COPY_RULES_CONFIG, cwd: FIXTURES, files: ['copy.tsx'] });
    const strings = copyStrings(findings, changed, overrides);
    const byText = new Map(strings.map((entry) => [entry.text, entry]));
    expect(byText.get('Create playlist')?.kind).toBe('button');
    expect(byText.get('Create playlist')?.problems).toEqual([]);
    expect(byText.get('Start Narration')?.problems).toHaveLength(1);
    expect(byText.get('Submit')?.kind).toBe('button');
    expect(byText.get('Turn written structure into something that sounds natural read aloud.')?.kind).toBe('description');
    expect(byText.get('Here you can easily manage your rewrite settings.')?.problems).toHaveLength(3);
    expect(byText.get('No downloads on this device yet. Save some audio. Then listen offline.')?.kind).toBe('empty-state');
    expect(byText.get('Locked — it stays until you unlock it.')?.problems).toEqual(['no em dashes']);
    expect(byText.get('Playlist created.')?.kind).toBe('text');
    const report = copyReport(strings);
    expect(report).toContain(`${strings.length} new or changed strings`);
    expect(report.split('\n').filter((line) => line.startsWith('- '))).toHaveLength(strings.length);
  });

  test('a string on an unchanged line is left out', async () => {
    const findings = await scan({ runner: hostRunner(FIXTURES), binary: AST_GREP, config: COPY_RULES_CONFIG, cwd: FIXTURES, files: ['copy.tsx'] });
    const strings = copyStrings(findings, new Map([['copy.tsx', new Set([8])]]), overrides);
    expect(strings.map((entry) => entry.text)).toEqual(['Create playlist']);
  });
});

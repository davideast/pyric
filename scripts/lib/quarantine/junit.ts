// Reads a `bun test --reporter=junit` file into test results, and the totals
// bun prints at the end of its console output. Both are needed: the JUnit file
// leaves out an "Unhandled error between tests" and a file that fails to load,
// which only the console totals count.

import { SEPARATOR, type TestResult } from './entries.ts';

const TAG = /<(\/?)(testsuites|testsuite|testcase|failure|error|skipped)\b((?:[^>"]|"[^"]*")*?)(\/?)>/g;
const ATTRIBUTE = /([\w:-]+)="([^"]*)"/g;
const ANSI = /\u001b\[[0-9;]*m/g;
const FAIL_TOTAL = /^\s*(\d+) fail$/;
const ERROR_TOTAL = /^\s*(\d+) errors?$/;

function unescape(text: string): string {
  return text
    .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, decimal: string) => String.fromCodePoint(Number(decimal)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, '\'')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

function attributes(text: string): Record<string, string> {
  const found: Record<string, string> = {};
  for (const match of text.matchAll(ATTRIBUTE)) found[match[1] ?? ''] = unescape(match[2] ?? '');
  return found;
}

/** Joins a path relative to where bun ran onto that directory's repo path. */
export function repoPath(cwd: string, file: string): string {
  const relative = file.replace(/^\.\//, '');
  if (cwd === '' || cwd === '.') return relative;
  return `${cwd.replace(/\/$/, '')}/${relative}`;
}

interface OpenCase {
  file: string;
  names: string[];
  outcome: TestResult['outcome'];
  line?: number;
}

function caseResult(open: OpenCase): TestResult {
  const result: TestResult = { id: [open.file, ...open.names].join(SEPARATOR), file: open.file, outcome: open.outcome };
  if (open.line !== undefined) result.line = open.line;
  return result;
}

function lineOf(attrs: Record<string, string>): number | undefined {
  const line = Number(attrs.line);
  if (Number.isInteger(line) && line > 0) return line;
  return undefined;
}

/** The test results in a JUnit file, named as the console names them: the
 *  file, then each enclosing describe, then the test. `cwd` is the repo path
 *  of the directory bun ran in. bun's own `classname` lists the describes in
 *  reverse, so the names come from the nested suites. Throws on a file that
 *  is not bun JUnit. */
export function parseJunit(xml: string, cwd: string): TestResult[] {
  if (!xml.includes('<testsuites')) throw new Error('not a JUnit file: no <testsuites>');
  const results: TestResult[] = [];
  /** The describes enclosing the current point, below the file's suite. */
  const describes: string[] = [];
  let depth = 0;
  let file = '';
  let open: OpenCase | undefined;
  for (const match of xml.matchAll(TAG)) {
    const [, closing = '', tag, attributeText = '', selfClosing = ''] = match;
    const attrs = attributes(attributeText);
    const opens = closing === '' && selfClosing === '';
    const closes = closing === '/';
    if (tag === 'testsuite' && opens) {
      if (depth === 0) file = repoPath(cwd, attrs.file ?? attrs.name ?? '');
      else describes.push(attrs.name ?? '');
      depth += 1;
    } else if (tag === 'testsuite' && closes) {
      if (depth >= 2) describes.pop();
      depth -= 1;
    } else if (tag === 'testcase' && closes) {
      if (open) results.push(caseResult(open));
      open = undefined;
    } else if (tag === 'testcase') {
      const started: OpenCase = { file, names: [...describes, attrs.name ?? ''], outcome: 'passed', line: lineOf(attrs) };
      if (selfClosing === '/') results.push(caseResult(started));
      else open = started;
    } else if (open && (tag === 'failure' || tag === 'error')) {
      open.outcome = 'failed';
    } else if (open && tag === 'skipped' && open.outcome === 'passed') {
      open.outcome = 'skipped';
    }
  }
  return results;
}

export interface ConsoleTotals {
  /** The `N fail` total, or undefined when the output has none. */
  fail?: number;
  /** The `N error` total; 0 when bun printed none. */
  errors: number;
}

/** The last `N fail` and `N error` totals bun printed. */
export function consoleTotals(output: string): ConsoleTotals {
  const totals: ConsoleTotals = { errors: 0 };
  for (const line of output.replace(ANSI, '').split('\n')) {
    const text = line.replace(/\r$/, '');
    const fail = FAIL_TOTAL.exec(text);
    if (fail) totals.fail = Number(fail[1]);
    const errors = ERROR_TOTAL.exec(text);
    if (errors) totals.errors = Number(errors[1]);
  }
  return totals;
}

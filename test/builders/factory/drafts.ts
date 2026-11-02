/**
 * Issue drafts that triage writes to `<run>/issue-drafts/<slug>.md`, and
 * their check against pyric's issue standard (AGENTS.md, "Issues"): a title
 * in the kind's pattern, exactly one label, the kind's four bold fields,
 * each with text, and a "Found by" line.
 *
 *   Title: Firestore: pyric allows X, production refuses it
 *   Label: divergence
 *
 *   **pyric:** ...
 *   **Production:** ... [Reference](https://firebase.google.com/...)
 *   **Who notices:** ...
 *   **Done when:** ...
 *
 *   Found by factory run 2026-11-01, item search-query.
 *
 * Triage files nothing; the coordinator reads these in the morning.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export interface IssueKind {
  /** The kind's one label, or the pattern its label must match. */
  label: string | RegExp;
  title: RegExp;
  titlePattern: string;
  fields: readonly string[];
}

export const ISSUE_KINDS: readonly IssueKind[] = [
  { label: 'support', title: /^Support \S.* in \S.*$/, titlePattern: 'Support <API> in <package>', fields: ['Missing', 'In production', 'Workaround', 'Done when'] },
  { label: 'divergence', title: /^[^:]+: pyric .+, production .+$/, titlePattern: '<Service>: pyric <does X>, production <does Y>', fields: ['pyric', 'Production', 'Who notices', 'Done when'] },
  { label: 'bug', title: /^\S.* when \S.*$/, titlePattern: '<What breaks> when <condition>', fields: ['What breaks', 'Expected', 'Repro', 'Done when'] },
  { label: 'security', title: /^Security: \S.*$/, titlePattern: 'Security: <what is exposed> <to whom>', fields: ['Exposure', 'Who can reach it', 'Fix', 'Done when'] },
  { label: 'flake', title: /^(Flaky|Red on main): \S.*$/, titlePattern: 'Flaky: <test> or Red on main: <check>', fields: ['Fails how', 'Since', 'Cause', 'Done when'] },
  { label: 'documentation', title: /^Docs: [^:]+: \S.*$/, titlePattern: 'Docs: <page>: <what is wrong>', fields: ['Says', 'Should say', 'Done when'] },
  { label: 'plan', title: /^Plan: \S.*$/, titlePattern: 'Plan: <outcome>', fields: ['Goal', 'Steps', 'Decisions', 'Done when'] },
  { label: /^lane:[a-z0-9-]+$/, title: /^CI: \S.*$/, titlePattern: 'CI: <what changes>', fields: ['Problem', 'Change', 'Done when'] },
];

export interface ParsedDraft {
  title?: string;
  labels: string[];
  /** Each bold field's text: the rest of its line and the lines up to the next field or the "Found by" line. */
  fields: Map<string, string>;
  foundBy?: string;
}

export interface DraftCheck {
  file: string;
  title?: string;
  errors: string[];
}

const TITLE_LINE = /^Title:\s*(.*)$/;
const LABEL_LINE = /^Labels?:\s*(.*)$/;
const FIELD_LINE = /^\*\*([^*]+?):\*\*\s*(.*)$/;
const FOUND_BY_LINE = /^Found by\s+\S/;

function splitLabels(text: string): string[] {
  return text.split(',').map((label) => label.trim()).filter((label) => label.length > 0);
}

export function parseDraft(text: string): ParsedDraft {
  const draft: ParsedDraft = { labels: [], fields: new Map() };
  let field: string | undefined;
  for (const line of text.split(/\r?\n/)) {
    const title = TITLE_LINE.exec(line);
    const label = LABEL_LINE.exec(line);
    const bold = FIELD_LINE.exec(line);
    if (title !== null && draft.title === undefined) draft.title = (title[1] ?? '').trim();
    else if (label !== null) draft.labels.push(...splitLabels(label[1] ?? ''));
    else if (bold !== null) {
      field = (bold[1] ?? '').trim();
      draft.fields.set(field, (bold[2] ?? '').trim());
    } else if (FOUND_BY_LINE.test(line)) {
      field = undefined;
      draft.foundBy = line.trim();
    } else if (field !== undefined) {
      draft.fields.set(field, `${draft.fields.get(field) ?? ''}\n${line}`.trim());
    }
  }
  return draft;
}

function labelMatches(kind: IssueKind, label: string): boolean {
  return typeof kind.label === 'string' ? kind.label === label : kind.label.test(label);
}

export function kindForLabel(label: string): IssueKind | undefined {
  return ISSUE_KINDS.find((kind) => labelMatches(kind, label));
}

function fieldErrors(kind: IssueKind, fields: ReadonlyMap<string, string>): string[] {
  return kind.fields.flatMap((name) => {
    const text = fields.get(name);
    if (text === undefined) return [`missing the **${name}:** field`];
    return text.length === 0 ? [`the **${name}:** field is empty`] : [];
  });
}

function labelErrors(labels: readonly string[]): string[] {
  if (labels.length === 0) return ['missing the "Label:" line'];
  if (labels.length > 1) return [`takes one label, found ${labels.length}: ${labels.join(', ')}`];
  const [label = ''] = labels;
  return kindForLabel(label) === undefined ? [`unknown label "${label}"`] : [];
}

function titleErrors(kind: IssueKind | undefined, title: string | undefined): string[] {
  if (title === undefined || title.length === 0) return ['missing the "Title:" line'];
  const isWrongPattern = kind !== undefined && !kind.title.test(title);
  return isWrongPattern ? [`the title does not match "${kind.titlePattern}"`] : [];
}

/** Every way the draft breaks the issue standard; empty when it holds. */
export function validateDraft(text: string): string[] {
  const draft = parseDraft(text);
  const errors = labelErrors(draft.labels);
  const kind = errors.length === 0 ? kindForLabel(draft.labels[0] ?? '') : undefined;
  errors.push(...titleErrors(kind, draft.title));
  if (kind !== undefined) errors.push(...fieldErrors(kind, draft.fields));
  if (draft.foundBy === undefined) errors.push('missing the "Found by" line');
  return errors;
}

export function draftsDir(runDir: string): string {
  return join(runDir, 'issue-drafts');
}

/** The run's drafts, by file name, each with what breaks the standard. */
export function checkDrafts(runDir: string): DraftCheck[] {
  const dir = draftsDir(runDir);
  if (!existsSync(dir)) return [];
  const files = readdirSync(dir).filter((name) => name.endsWith('.md')).sort();
  return files.map((file) => {
    const text = readFileSync(join(dir, file), 'utf8');
    const { title } = parseDraft(text);
    return { file, ...(title === undefined ? {} : { title }), errors: validateDraft(text) };
  });
}

function formatCheck(check: DraftCheck): string[] {
  const mark = check.errors.length === 0 ? 'valid' : 'invalid';
  const head = `${mark}  ${check.file}  ${check.title ?? '(no title)'}`;
  return [head, ...check.errors.map((error) => `    ${error}`)];
}

function countDrafts(count: number): string {
  if (count === 1) return '1 draft';
  return `${count} drafts`;
}

export function formatDrafts(dir: string, checks: readonly DraftCheck[]): string {
  if (checks.length === 0) return `no issue drafts in ${dir}`;
  const invalid = checks.filter((check) => check.errors.length > 0).length;
  const lines = checks.flatMap(formatCheck);
  return [...lines, '', `${countDrafts(checks.length)} in ${dir}, ${invalid} invalid`].join('\n');
}

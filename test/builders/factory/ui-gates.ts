/**
 * The static UI gates over what changed since the run's start: the factory's
 * ast-grep rules, new files in `components/ui`, and the copy check. Each
 * judges only added or changed lines (`diff-lines.ts`).
 */
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { scan, type Finding } from './ast-grep.ts';
import { copyProblems, type CopyKind, type CopyOverrides } from './copy-rules.ts';
import { touches, type ChangedLines } from './diff-lines.ts';
import type { Runner } from './exec.ts';

export const UI_RULES_CONFIG = fileURLToPath(new URL('./ui-rules/sgconfig.yml', import.meta.url));
export const COPY_RULES_CONFIG = fileURLToPath(new URL('./ui-rules/copy/sgconfig.yml', import.meta.url));

/** The comment that lets one absolute element through: `ui-overlay: <what it overlays>`. */
export const OVERLAY_MARKER = /ui-overlay:\s*\S/;
const ABSOLUTE_RULES = new Set(['factory-no-absolute-layout', 'factory-no-absolute-layout-css']);
const UI_FILES = /\.(tsx?|css)$/;
const COMPONENTS_UI = /(^|\/)components\/ui\/[^/]+$/;

export interface Violation {
  rule: string;
  file: string;
  line: number;
  message: string;
  text: string;
}

function lineOf(lines: readonly string[], line: number): string {
  return lines[line - 1] ?? '';
}

/** Whether the finding's line, or the line above, carries the overlay marker. */
export function hasOverlayMarker(source: string, line: number): boolean {
  const lines = source.split('\n');
  return OVERLAY_MARKER.test(lineOf(lines, line)) || OVERLAY_MARKER.test(lineOf(lines, line - 1));
}

/** Findings on changed lines, less absolute overlays that are marked. `readSource` reads a file by its repo path. */
export function ruleViolations(findings: readonly Finding[], changed: ChangedLines, readSource: (file: string) => string): Violation[] {
  return findings
    .filter((finding) => touches(changed, finding.file, finding.line, finding.endLine))
    .filter((finding) => {
      const isAbsolute = ABSOLUTE_RULES.has(finding.ruleId);
      return !isAbsolute || !hasOverlayMarker(readSource(finding.file), finding.line);
    })
    .map((finding) => ({ rule: finding.ruleId, file: finding.file, line: finding.line, message: finding.message, text: finding.text }));
}

/** Approved new `components/ui` files, one repo or file name per line; `#` starts a comment. */
export function readApproved(path: string): Set<string> {
  if (!existsSync(path)) return new Set();
  const entries = readFileSync(path, 'utf8').split('\n').map((line) => line.replace(/#.*/, '').trim());
  return new Set(entries.filter((entry) => entry !== ''));
}

export function newComponentViolations(added: readonly string[], approved: ReadonlySet<string>): Violation[] {
  const isApproved = (file: string) => approved.has(file) || approved.has(file.split('/').at(-1) ?? '');
  return added
    .filter((file) => COMPONENTS_UI.test(file) && !isApproved(file))
    .map((file) => ({
      rule: 'factory-no-new-ui-component',
      file,
      line: 1,
      message: 'A new file in components/ui. Use an existing component, or add the file to approved-components.txt in the run directory once it is approved.',
      text: file,
    }));
}

export interface CopyString {
  file: string;
  line: number;
  kind: CopyKind;
  text: string;
  problems: string[];
}

/** The most specific kind wins when two extractors found one string. */
const KIND_ORDER: readonly CopyKind[] = ['button', 'empty-state', 'description', 'text'];

function kindOf(ruleId: string): CopyKind | undefined {
  const kind = ruleId.replace(/^copy-/, '');
  return KIND_ORDER.find((known) => known === kind);
}

/** One entry per string on a changed line, with its kind and problems. */
export function copyStrings(findings: readonly Finding[], changed: ChangedLines, overrides: CopyOverrides): CopyString[] {
  const byKey = new Map<string, { file: string; line: number; text: string; kind: CopyKind }>();
  for (const finding of findings) {
    const kind = kindOf(finding.ruleId);
    const text = finding.text.trim().replace(/\s+/g, ' ');
    const isCandidate = kind !== undefined && text !== '' && touches(changed, finding.file, finding.line, finding.endLine);
    if (!isCandidate) continue;
    const key = `${finding.file}:${finding.line}:${text}`;
    const earlier = byKey.get(key);
    const isMoreSpecific = earlier === undefined || KIND_ORDER.indexOf(kind) < KIND_ORDER.indexOf(earlier.kind);
    if (isMoreSpecific) byKey.set(key, { file: finding.file, line: finding.line, text, kind });
  }
  return [...byKey.values()].map((entry) => ({ ...entry, problems: copyProblems(entry.text, entry.kind, overrides) }));
}

export function copyReport(strings: readonly CopyString[]): string {
  const failing = strings.filter((entry) => entry.problems.length > 0).length;
  const lines = ['# Copy report', '', `${strings.length} new or changed strings, ${failing} failing.`, ''];
  for (const entry of strings) {
    const verdict = entry.problems.length === 0 ? 'passes' : `fails: ${entry.problems.join('; ')}`;
    lines.push(`- ${entry.kind}, \`${entry.file}:${entry.line}\`: "${entry.text}" ${verdict}`);
  }
  return `${lines.join('\n')}\n`;
}

export interface UiGateInput {
  runner: Runner;
  astGrep: string;
  /** Where the scans run: the tree's repo, inside its sandbox. */
  repo: string;
  changed: ChangedLines;
  added: readonly string[];
  approved: ReadonlySet<string>;
  overrides: CopyOverrides;
  /** A file's text at the checked commit, by its repo path: from the harness's repo, never the tree. */
  readSource: (file: string) => string;
}

export interface UiGateResult {
  violations: Violation[];
  copy: CopyString[];
}

/** Runs both scans over the changed files and judges what they found. */
export async function runUiGates(input: UiGateInput): Promise<UiGateResult> {
  const files = [...input.changed.keys()].filter((file) => UI_FILES.test(file));
  const tsxFiles = files.filter((file) => file.endsWith('.tsx'));
  const base = { runner: input.runner, binary: input.astGrep, cwd: input.repo };
  const ruleFindings = await scan({ ...base, config: UI_RULES_CONFIG, files });
  const copyFindings = await scan({ ...base, config: COPY_RULES_CONFIG, files: tsxFiles });
  return {
    violations: [...ruleViolations(ruleFindings, input.changed, input.readSource), ...newComponentViolations(input.added, input.approved)],
    copy: copyStrings(copyFindings, input.changed, input.overrides),
  };
}

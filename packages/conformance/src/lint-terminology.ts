#!/usr/bin/env bun
// Lints registry prose (and, optionally, the generated COMPAT.md files) for
// terminology that must not sit in a public codebase's published contract:
//
//   1. Colloquialisms — chat-borrowed phrasing that reads as informal shorthand
//      rather than a precise technical term.
//   2. GitHub issue references — "issue #123" or a parenthetical issue
//      attribution "(... issue #123)". This is distinct from a legitimate
//      in-matrix row cross-reference like "#10 onAuthStateChanged" (a `#N`
//      immediately followed by an API name/backtick, which points at another
//      compatibility-matrix row and is fine to keep).
//   3. Coding-tool / assistant names — "claude", "codex", branch names like
//      `claude/...`, and similar tool-flavored references. The registry
//      documents behavior, not which tool produced a commit.
//
// Run: `bun run packages/conformance/src/lint-terminology.ts`
// Wired as `compat:lint-terms` in package.json and run in CI.

import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { REPO_ROOT } from './ledger.ts';

const REGISTRY_DIR = join(REPO_ROOT, 'packages/conformance/registry');
const DOCS_GLOB_ROOTS = [join(REPO_ROOT, 'packages/site-docs/src/content/pyric')];

export interface TerminologyViolation {
  file: string;
  line: number;
  column: number;
  rule: string;
  term: string;
  excerpt: string;
}

// --- Rule 1: colloquialism denylist -----------------------------------
// Maintainable list of chat-borrowed / informal phrases that don't belong in
// a published compatibility contract. Matching is case-insensitive, exact
// substring (not fuzzy) — extend this list as new colloquialisms show up in
// review rather than trying to detect "informality" heuristically.
export const COLLOQUIALISM_DENYLIST: readonly string[] = [
  'low-hanging fruit',
  'low hanging fruit',
  'quick win',
  'easy win',
  'cheap win',
  'no-brainer',
  'no brainer',
  'slam dunk',
  'freebie',
  'gimme',
];

// --- Rule 3: coding-tool / assistant names -----------------------------
// Case-insensitive exact terms. Kept separate from the colloquialism list
// because the failure message and rationale differ.
export const CODING_TOOL_DENYLIST: readonly string[] = [
  'claude',
  'codex',
  'copilot',
  'chatgpt',
  'anthropic',
  'cursor ai',
];

// --- Rule 2: GitHub issue references ------------------------------------
// Matches "issue #123" (any case) and a parenthetical issue attribution
// like "(... issue #123)" or "(#123)" where the `#123` is not immediately
// followed by a word/backtick — i.e. not a row cross-reference such as
// "#10 onAuthStateChanged" or "#3 `getAuth`".
const ISSUE_PHRASE_RE = /\bissue\s+#\d+/gi;
// A bare "(#123)" parenthetical with nothing else naming an API — this is
// the "(... issue #149)"-shaped attribution once the word "issue" itself
// isn't present, e.g. "(see #149)" immediately closed by ")".
const PAREN_ISSUE_RE = /\(#\d+\)/g;

function isRowCrossReference(line: string, matchIndex: number, matchLength: number): boolean {
  // A row cross-reference looks like "#10 onAuthStateChanged" or
  // "#3 `getAuth`" — a `#N` followed by whitespace and then a word
  // character or backtick. If that shape holds immediately after the
  // matched span, it's a legitimate row reference, not an issue reference.
  const after = line.slice(matchIndex + matchLength);
  return /^ [\w`]/.test(after);
}

function scanFile(absPath: string): TerminologyViolation[] {
  const violations: TerminologyViolation[] = [];
  const relPath = relative(REPO_ROOT, absPath);
  const content = readFileSync(absPath, 'utf8');
  const lines = content.split('\n');

  lines.forEach((line, idx) => {
    const lower = line.toLowerCase();

    for (const term of COLLOQUIALISM_DENYLIST) {
      let from = 0;
      let at: number;
      while ((at = lower.indexOf(term, from)) !== -1) {
        violations.push({
          file: relPath,
          line: idx + 1,
          column: at + 1,
          rule: 'colloquialism',
          term,
          excerpt: line.trim().slice(0, 160),
        });
        from = at + term.length;
      }
    }

    for (const term of CODING_TOOL_DENYLIST) {
      let from = 0;
      let at: number;
      while ((at = lower.indexOf(term, from)) !== -1) {
        // Avoid matching inside unrelated longer identifiers where it's
        // clearly not a tool reference, e.g. "anthropic" substring of a
        // longer proper noun. In practice these denylist terms are
        // specific enough that a plain substring match is intentional —
        // any occurrence of "claude"/"codex"/etc. in registry prose is a
        // tool reference and should be flagged.
        violations.push({
          file: relPath,
          line: idx + 1,
          column: at + 1,
          rule: 'coding-tool-reference',
          term,
          excerpt: line.trim().slice(0, 160),
        });
        from = at + term.length;
      }
    }

    for (const match of line.matchAll(ISSUE_PHRASE_RE)) {
      violations.push({
        file: relPath,
        line: idx + 1,
        column: (match.index ?? 0) + 1,
        rule: 'github-issue-reference',
        term: match[0],
        excerpt: line.trim().slice(0, 160),
      });
    }

    for (const match of line.matchAll(PAREN_ISSUE_RE)) {
      const idxInLine = match.index ?? 0;
      if (isRowCrossReference(line, idxInLine + 1, match[0].length - 2)) continue;
      violations.push({
        file: relPath,
        line: idx + 1,
        column: idxInLine + 1,
        rule: 'github-issue-reference',
        term: match[0],
        excerpt: line.trim().slice(0, 160),
      });
    }
  });

  return violations;
}

function listTsFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.ts'))
    .map((entry) => join(dir, entry.name));
}

function listMarkdownFilesRecursive(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...listMarkdownFilesRecursive(full));
    } else if (entry.isFile() && entry.name === 'COMPAT.md') {
      out.push(full);
    }
  }
  return out;
}

export function lintTerminology(options: { includeGeneratedDocs?: boolean } = {}): TerminologyViolation[] {
  const files = listTsFiles(REGISTRY_DIR);
  if (options.includeGeneratedDocs ?? true) {
    for (const root of DOCS_GLOB_ROOTS) {
      files.push(...listMarkdownFilesRecursive(root));
    }
  }
  return files.flatMap(scanFile);
}

if (import.meta.main) {
  const violations = lintTerminology();

  if (violations.length === 0) {
    console.log('compat:lint-terms — clean (no colloquialisms, issue references, or tool names in registry prose).');
    process.exit(0);
  }

  console.error(`compat:lint-terms — found ${violations.length} terminology violation(s):\n`);
  for (const v of violations) {
    console.error(`  ${v.file}:${v.line}:${v.column}  [${v.rule}] "${v.term}"`);
    console.error(`    ${v.excerpt}`);
  }
  console.error(
    '\nRegistry prose (and the generated COMPAT.md files) must be direct and technically precise: ' +
    'no colloquialisms, no GitHub issue numbers, no coding-tool/assistant names. ' +
    'Row cross-references like "#10 onAuthStateChanged" are fine — only "issue #N" and ' +
    'parenthetical issue attributions like "(#N)" are flagged.'
  );
  process.exit(1);
}

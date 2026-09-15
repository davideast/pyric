import { applyCodeFormExceptions } from './code-form-exceptions.js';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { checkChangedCodeForm } from './check-code-form.js';

const requestedBase = process.argv[2];
const hasNoBase = requestedBase === undefined;
if (hasNoBase) throw new Error('Usage: bun scripts/check-changed-code-form.ts <base-revision>');

function git(args: string[]): string {
  return execFileSync('git', args, { encoding: 'utf8' });
}

function sha256(source: string): string {
  return createHash('sha256').update(source).digest('hex');
}

const baseRevision = git(['rev-parse', '--verify', '--end-of-options', `${requestedBase}^{commit}`]).trim();
const basePaths = new Set(git(['ls-tree', '-rz', '--name-only', baseRevision]).split('\0'));
const changedPaths = git(['diff', '--name-only', '-z', '--diff-filter=ACMR', baseRevision]);
const addedPaths = git(['ls-files', '--others', '--exclude-standard', '-z']);
const candidates = new Set((changedPaths + addedPaths).split('\0'));
const paths = [...candidates].filter((path) => /\.(?:[cm]?ts|tsx)$/.test(path)).sort();
const program = ts.createProgram(paths, {
  noEmit: true,
  strict: true,
  target: ts.ScriptTarget.ESNext,
  module: ts.ModuleKind.NodeNext,
  moduleResolution: ts.ModuleResolutionKind.NodeNext,
  jsx: ts.JsxEmit.ReactJSX,
});
const files = paths.map((path) => {
  const after = readFileSync(path, 'utf8');
  const existedAtBase = basePaths.has(path);
  let before: string | undefined;
  let baseDigest: string | null = null;
  if (existedAtBase) {
    before = git(['show', `${baseRevision}:${path}`]);
    baseDigest = sha256(before);
  }
  const checked = checkChangedCodeForm({ before, after, fileName: path, program });
  const reviewed = applyCodeFormExceptions(path, before, after, checked.issues);
  const hasPermitted = reviewed.permitted.length > 0;
  return {
    path,
    sourceDigest: sha256(after),
    baseDigest,
    ...checked,
    issues: reviewed.issues,
    permitted: hasPermitted ? reviewed.permitted : undefined,
  };
});

console.log(JSON.stringify({ schema: 'pyric.code-form-report.v1', baseRevision, files }, null, 2));
const hasIssues = files.some((file) => file.issues.length > 0);
if (hasIssues) process.exitCode = 1;

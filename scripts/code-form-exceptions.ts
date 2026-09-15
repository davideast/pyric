import { existsSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import ts from 'typescript';
import { z } from 'zod';
import type { CodeFormIssue } from './check-code-form.js';

const exceptionSchema = z.array(z.object({
  path: z.string(), rule: z.literal('double-assertion'), target: z.string(),
  sourceDigest: z.string().regex(/^[a-f0-9]{64}$/), reason: z.string().min(1),
}));

/** U3 permits individually recorded foreign SDK casts, never a blanket file exemption. */
export function applyCodeFormExceptions(path: string, before: string | undefined, after: string, issues: CodeFormIssue[]) {
  const manifest = 'scripts/code-form-exceptions.json';
  const hasManifest = existsSync(manifest);
  const entries = hasManifest ? exceptionSchema.parse(JSON.parse(readFileSync(manifest, 'utf8'))) : [];
  const source = ts.createSourceFile(path, after, ts.ScriptTarget.Latest, true);
  const previousSource = ts.createSourceFile(path, before ?? '', ts.ScriptTarget.Latest, true);
  const previousCasts = new Set<string>();
  function collectPrevious(node: ts.Node): void {
    const isDoubleCast = ts.isAsExpression(node) && ts.isAsExpression(node.expression);
    if (isDoubleCast) previousCasts.add(node.getText(previousSource));
    ts.forEachChild(node, collectPrevious);
  }
  collectPrevious(previousSource);
  const permitted: { issue: CodeFormIssue; reason: string; sourceDigest: string }[] = [];
  const remaining = issues.filter(issue => {
    const isNotCast = issue.rule !== 'double-assertion';
    if (isNotCast) return true;
    const position = source.getPositionOfLineAndCharacter(issue.line - 1, issue.column - 1);
    let cast: ts.AsExpression | undefined;
    function visit(node: ts.Node): void {
      const isMatchingCast = ts.isAsExpression(node) && node.getStart(source) === position;
      if (isMatchingCast) { cast ??= node; return; }
      ts.forEachChild(node, visit);
    }
    visit(source);
    const matchingCast = cast;
    const missingCast = matchingCast === undefined;
    if (missingCast) return true;
    const expression = matchingCast.getText(source);
    const isNewCast = !previousCasts.has(expression);
    if (isNewCast) return true;
    const sourceDigest = createHash('sha256').update(expression).digest('hex');
    const target = matchingCast.type.getText(source);
    const entry = entries.find(candidate => candidate.path === path && candidate.target === target && candidate.sourceDigest === sourceDigest);
    const missingException = entry === undefined;
    if (missingException) return true;
    entries.splice(entries.indexOf(entry), 1);
    permitted.push({ issue, sourceDigest, reason: entry.reason });
    return false;
  });
  return { issues: remaining, permitted };
}

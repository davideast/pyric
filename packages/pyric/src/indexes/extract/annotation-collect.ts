/**
 * AST walker that pairs each function-like declaration with its leading
 * JSDoc-style comment block, parses any `@firestore-*` tags out of it,
 * and yields the parsed annotations alongside the function name.
 *
 * Pure walker — no enumeration logic, no pruning. The orchestrator
 * (`extractor.ts`) consumes these and threads them into `enumerateShapes`.
 *
 * Coverage matches `iterFunctionBodies` (see Issue A1 in the layer-2
 * progress doc):
 *   - function declarations
 *   - arrow / function expressions assigned to a variable
 * Method declarations on classes are deliberately out of scope for v1
 * because Firebase query builders are almost never methods. Add when
 * real-world demand surfaces.
 */
import ts from 'typescript';
import { parseAnnotations, type AnnotationWarning, type Annotations } from './annotations.js';

/** One function paired with its parsed annotations. */
export interface CollectedAnnotation {
  /** Function name, or `'<anon>'` for an unnamed function expression. */
  functionName: string;
  /** Annotations parsed from the function's leading comment block. */
  annotations: Annotations;
  /** Warnings raised while parsing those annotations. */
  warnings: AnnotationWarning[];
  /**
   * `true` when the leading comment block contained at least one
   * `@firestore-*` tag (recognized or not). Useful so the orchestrator
   * can skip emitting an `AnnotationApplied` summary for functions
   * without any annotation activity.
   */
  hasFirestoreTag: boolean;
}

/**
 * Walk every function-like declaration in a SourceFile and yield one
 * `CollectedAnnotation` per declaration. Functions without leading
 * comments still appear with empty annotations and `hasFirestoreTag:
 * false` — the caller decides whether to keep them.
 */
export function collectAnnotations(sf: ts.SourceFile): CollectedAnnotation[] {
  const out: CollectedAnnotation[] = [];
  const fullText = sf.getFullText();

  function record(name: string, node: ts.Node): void {
    const commentText = leadingCommentTextOf(node, fullText);
    const { annotations, warnings } = parseAnnotations(commentText);
    const hasFirestoreTag = /@firestore-[a-zA-Z0-9_-]+/.test(commentText);
    out.push({ functionName: name, annotations, warnings, hasFirestoreTag });
  }

  function visit(n: ts.Node): void {
    if (ts.isFunctionDeclaration(n) && n.body) {
      const name = n.name?.text ?? '<anon>';
      record(name, n);
    } else if (ts.isVariableStatement(n)) {
      for (const d of n.declarationList.declarations) {
        if (
          d.initializer &&
          (ts.isArrowFunction(d.initializer) || ts.isFunctionExpression(d.initializer))
        ) {
          const name = ts.isIdentifier(d.name) ? d.name.text : '<anon>';
          // Use the variable statement as the comment anchor — leading
          // comments attach to the statement, not the initializer.
          record(name, n);
        }
      }
    }
    ts.forEachChild(n, visit);
  }

  visit(sf);
  return out;
}

/**
 * Concatenate every leading comment range attached to `node` into a
 * single string. Returns `''` if no leading comments exist.
 *
 * `ts.getLeadingCommentRanges` returns spans into the full source text;
 * we slice them and join with newlines so multi-block leading comments
 * (rare but legal) all participate in the parse.
 */
function leadingCommentTextOf(node: ts.Node, fullText: string): string {
  const ranges = ts.getLeadingCommentRanges(fullText, node.getFullStart());
  if (!ranges || ranges.length === 0) return '';
  return ranges.map(r => fullText.slice(r.pos, r.end)).join('\n');
}

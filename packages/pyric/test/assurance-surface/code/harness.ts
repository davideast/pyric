/**
 * Test harness for the access-site extractor's internals: builds an
 * evaluator over in-memory files and finds expressions by text.
 * Not a test file itself.
 */
import ts from 'typescript';
import { buildPrograms } from '../../../src/assurance-surface/code/program.js';
import { ReferenceIndex } from '../../../src/assurance-surface/code/references.js';
import { SdkTable } from '../../../src/assurance-surface/code/sdk-imports.js';
import { Evaluator } from '../../../src/assurance-surface/code/evaluator.js';
import type { AccessPreset } from '../../../src/assurance-surface/code/types.js';

export const ROOT = '/virtual/app';

export interface Harness {
  ev: Evaluator;
  refs: ReferenceIndex;
  checker: ts.TypeChecker;
  file(name: string): ts.SourceFile;
  /** The first expression in `file` whose text is exactly `text` (optionally the nth match). */
  expr(file: string, text: string, nth?: number): ts.Expression;
  /** The first identifier named `name` in `file`. */
  ident(file: string, name: string, nth?: number): ts.Identifier;
}

export function harness(files: Record<string, string>, presets: AccessPreset[] = []): Harness {
  const [p] = buildPrograms(ROOT, files, []);
  const indexed = p.program.getSourceFiles().filter((sf) => !sf.isDeclarationFile);
  const refs = new ReferenceIndex(p.checker, indexed);
  const ev = new Evaluator(p.checker, refs, new SdkTable(presets));
  const file = (name: string): ts.SourceFile => {
    const sf = p.program.getSourceFile(`${ROOT}/${name}`);
    if (!sf) throw new Error(`no file ${name}`);
    return sf;
  };
  const find = <T extends ts.Node>(name: string, pred: (n: ts.Node) => n is T, nth: number): T => {
    const hits: T[] = [];
    const visit = (n: ts.Node): void => {
      if (pred(n)) hits.push(n);
      ts.forEachChild(n, visit);
    };
    visit(file(name));
    if (!hits[nth]) throw new Error(`not found in ${name}`);
    return hits[nth];
  };
  return {
    ev,
    refs,
    checker: p.checker,
    file,
    expr: (name, text, nth = 0) => find(name, (n): n is ts.Expression => ts.isExpression(n) && n.getText() === text, nth),
    ident: (name, id, nth = 0) => find(name, (n): n is ts.Identifier => ts.isIdentifier(n) && n.text === id, nth),
  };
}

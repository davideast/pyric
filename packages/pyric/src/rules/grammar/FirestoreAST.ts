/** Typed AST for Firestore Security Rules. */

/** 1-indexed source position. `col` is 1-indexed too. */
export interface SourceLoc {
  line: number;
  col: number;
  file?: string;
}

export interface ImportDecl {
  functions: string[];
  module: string;
  loc?: SourceLoc;
}

export interface FirestoreRules {
  version: string;
  imports: ImportDecl[];
  /** Functions declared at global scope (between the header lines and the
   *  service block). Visible everywhere inside the service. Absent on ASTs
   *  constructed programmatically. */
  functions?: FunctionDef[];
  service: ServiceBlock;
  loc?: SourceLoc;
}

export interface ServiceBlock {
  name: string;
  /** Functions declared directly inside `service { }`, outside any match.
   *  Visible everywhere inside the service. Absent on ASTs constructed
   *  programmatically. */
  functions?: FunctionDef[];
  match: MatchBlock;
  loc?: SourceLoc;
}

export interface MatchBlock {
  path: PathPattern;
  functions: FunctionDef[];
  allows: AllowRule[];
  children: MatchBlock[];
  /** Source position of the `match` keyword. Populated by the parser;
   *  absent on blocks constructed programmatically. Used by the
   *  path-resolution trace to attribute "near-miss" blocks to their
   *  source line. */
  loc?: SourceLoc;
}

export interface PathPattern {
  raw: string;
  segments: PathSegment[];
}

export type PathSegment =
  | { type: 'literal'; value: string }
  | { type: 'wildcard'; name: string }
  | { type: 'recursive'; name: string };

export interface AllowRule {
  operations: Operation[];
  condition: Expression;
  /** Source position of the `allow` keyword. Populated by the parser;
   *  absent on rules constructed programmatically (e.g. lint test fixtures). */
  loc?: SourceLoc;
}

export type Operation = 'read' | 'write' | 'get' | 'list' | 'create' | 'update' | 'delete';

export interface FunctionDef {
  name: string;
  parameters: string[];
  exported: boolean;
  lets: LetBinding[];
  body: Expression;
  loc?: SourceLoc;
}

export interface LetBinding {
  name: string;
  value: Expression;
  loc?: SourceLoc;
}

export type Expression =
  | { type: 'literal'; value: string | number | boolean | null; raw: string; loc?: SourceLoc }
  | { type: 'identifier'; name: string; loc?: SourceLoc }
  | { type: 'memberAccess'; object: Expression; property: string; loc?: SourceLoc }
  | { type: 'methodCall'; object: Expression; method: string; args: Expression[]; loc?: SourceLoc }
  | { type: 'bracketAccess'; object: Expression; index: Expression; loc?: SourceLoc }
  | { type: 'sliceAccess'; object: Expression; start: Expression; end: Expression; loc?: SourceLoc }
  | { type: 'binaryOp'; op: string; left: Expression; right: Expression; loc?: SourceLoc }
  | { type: 'unaryOp'; op: string; operand: Expression; loc?: SourceLoc }
  | { type: 'ternary'; condition: Expression; consequent: Expression; alternate: Expression; loc?: SourceLoc }
  | { type: 'inExpr'; element: Expression; collection: Expression; loc?: SourceLoc }
  | { type: 'isExpr'; value: Expression; typeName: string; loc?: SourceLoc }
  | { type: 'listLiteral'; elements: Expression[]; loc?: SourceLoc }
  | { type: 'mapLiteral'; entries: Array<{ key: Expression; value: Expression }>; loc?: SourceLoc }
  | { type: 'pathLiteral'; raw: string; segments: Array<string | Expression>; loc?: SourceLoc }
  | { type: 'functionCall'; name: string; args: Expression[]; loc?: SourceLoc };


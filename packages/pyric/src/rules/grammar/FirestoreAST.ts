/** Typed AST for Firestore Security Rules. */

/** 1-indexed source position. `col` is 1-indexed too. */
export interface SourceLoc {
  line: number;
  col: number;
}

export interface ImportDecl {
  functions: string[];
  module: string;
}

export interface FirestoreRules {
  version: string;
  imports: ImportDecl[];
  service: ServiceBlock;
}

export interface ServiceBlock {
  name: string;
  match: MatchBlock;
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
}

export interface LetBinding {
  name: string;
  value: Expression;
}

export type Expression =
  | { type: 'literal'; value: string | number | boolean | null; raw: string }
  | { type: 'identifier'; name: string }
  | { type: 'memberAccess'; object: Expression; property: string }
  | { type: 'methodCall'; object: Expression; method: string; args: Expression[] }
  | { type: 'bracketAccess'; object: Expression; index: Expression }
  | { type: 'sliceAccess'; object: Expression; start: Expression; end: Expression }
  | { type: 'binaryOp'; op: string; left: Expression; right: Expression }
  | { type: 'unaryOp'; op: string; operand: Expression }
  | { type: 'ternary'; condition: Expression; consequent: Expression; alternate: Expression }
  | { type: 'inExpr'; element: Expression; collection: Expression }
  | { type: 'isExpr'; value: Expression; typeName: string }
  | { type: 'listLiteral'; elements: Expression[] }
  | { type: 'mapLiteral'; entries: Array<{ key: Expression; value: Expression }> }
  | { type: 'pathLiteral'; raw: string; segments: Array<string | Expression> }
  | { type: 'functionCall'; name: string; args: Expression[] };

/**
 * Reference index over one program: where a symbol is used, assigned, and
 * called. The evaluator uses it to follow values backwards: a parameter's
 * values are the arguments its callers pass, a `let`'s values are every
 * assignment to it, a class field's values are every `this.x = ...`.
 *
 * Identifiers are grouped by text once; a symbol's references are the
 * identifiers with its name that the checker resolves to it.
 */
import ts from 'typescript';

/** How a reference to a callable is used. */
export type CallableUse =
  | { kind: 'call'; call: ts.CallExpression | ts.NewExpression }
  | { kind: 'jsx'; element: ts.JsxOpeningLikeElement }
  | { kind: 'callback'; call: ts.CallExpression; argIndex: number };

/** An assignment whose target resolves to a symbol. */
export interface Assignment {
  /** Right-hand side. */
  rhs: ts.Expression;
  /** Property path from the right-hand side to the target, for destructuring assignments. */
  path: (string | number)[];
  /** Assignment operator token kind (`=`, `||=`, `??=`, `&&=`). */
  operator: ts.SyntaxKind;
  /** Binary expression performing the assignment. */
  binary: ts.BinaryExpression;
}

export class ReferenceIndex {
  private readonly byName = new Map<string, ts.Identifier[]>();
  private readonly refCache = new Map<ts.Symbol, ts.Identifier[]>();

  constructor(
    private readonly checker: ts.TypeChecker,
    files: readonly ts.SourceFile[],
  ) {
    for (const sf of files) this.indexFile(sf);
  }

  private indexFile(sf: ts.SourceFile): void {
    const visit = (n: ts.Node): void => {
      if (ts.isIdentifier(n)) {
        const list = this.byName.get(n.text);
        if (list) list.push(n);
        else this.byName.set(n.text, [n]);
      }
      ts.forEachChild(n, visit);
    };
    visit(sf);
  }

  /** The symbol an identifier refers to, seeing through shorthand properties and in-project aliases. */
  symbolOf(id: ts.Identifier): ts.Symbol | undefined {
    let sym: ts.Symbol | undefined;
    if (ts.isShorthandPropertyAssignment(id.parent) && id.parent.name === id) {
      sym = this.checker.getShorthandAssignmentValueSymbol(id.parent);
    } else {
      sym = this.checker.getSymbolAtLocation(id);
    }
    return sym;
  }

  /** Resolve an alias symbol to its in-project target; returns the symbol itself when not an alias. */
  resolveAlias(sym: ts.Symbol): ts.Symbol | undefined {
    if (!(sym.flags & ts.SymbolFlags.Alias)) return sym;
    try {
      const target = this.checker.getAliasedSymbol(sym);
      if (!target || target.flags === ts.SymbolFlags.None || !target.declarations?.length) return undefined;
      return target;
    } catch {
      return undefined;
    }
  }

  /** Every identifier that resolves to `sym` (after alias resolution), excluding its declarations' names. */
  referencesOf(sym: ts.Symbol): ts.Identifier[] {
    const cached = this.refCache.get(sym);
    if (cached) return cached;
    const declNames = new Set<ts.Node>();
    for (const d of sym.declarations ?? []) {
      const name = (d as ts.NamedDeclaration).name;
      if (name) declNames.add(name);
    }
    const out: ts.Identifier[] = [];
    for (const id of this.byName.get(sym.name) ?? []) {
      if (declNames.has(id)) continue;
      const s = this.symbolOf(id);
      if (!s) continue;
      if (s === sym || this.resolveAlias(s) === sym) out.push(id);
    }
    this.refCache.set(sym, out);
    return out;
  }

  /**
   * The expression a reference stands for at its use site: the identifier,
   * or the property access it is the name of (`this.x`, `obj.fn`).
   */
  static useExpression(id: ts.Identifier): ts.Expression {
    const p = id.parent;
    if ((ts.isPropertyAccessExpression(p) && p.name === id)) return p;
    return id;
  }

  /** Every place a callable symbol is called, rendered as a JSX tag, or passed as a callback. */
  usesOfCallable(sym: ts.Symbol): CallableUse[] {
    const out: CallableUse[] = [];
    for (const id of this.referencesOf(sym)) {
      const use = classifyUse(ReferenceIndex.useExpression(id));
      if (use) out.push(use);
    }
    return out;
  }

  /** Assignments `x = rhs`, `this.x = rhs`, and destructuring assignments targeting `sym`. */
  assignmentsTo(sym: ts.Symbol): Assignment[] {
    const out: Assignment[] = [];
    for (const id of this.referencesOf(sym)) {
      const target = ReferenceIndex.useExpression(id);
      const found = assignmentFor(target);
      if (found) out.push(found);
    }
    return out;
  }

  /** Right-hand sides of `x[k] = rhs` (and `this.x[k] = rhs`) where `x` resolves to `sym`. */
  elementAssignments(sym: ts.Symbol): ts.Expression[] {
    const out: ts.Expression[] = [];
    for (const id of this.referencesOf(sym)) {
      const target = ReferenceIndex.useExpression(id);
      const p = target.parent;
      if (ts.isElementAccessExpression(p) && p.expression === target && isAssignmentTarget(p)) {
        out.push((p.parent as ts.BinaryExpression).right);
      }
    }
    return out;
  }

  keyedElementAssignments(sym: ts.Symbol): { key: ts.Expression; rhs: ts.Expression }[] {
    const out: { key: ts.Expression; rhs: ts.Expression }[] = [];
    for (const id of this.referencesOf(sym)) {
      const target = ReferenceIndex.useExpression(id);
      const p = target.parent;
      if (ts.isElementAccessExpression(p) && p.expression === target && isAssignmentTarget(p)) {
        out.push({ key: p.argumentExpression, rhs: (p.parent as ts.BinaryExpression).right });
      }
    }
    return out;
  }

  /** `v.prop = rhs` assignments on a variable symbol, by property name. */
  propertyAssignments(sym: ts.Symbol): { name: string; rhs: ts.Expression; node: ts.Node }[] {
    const out: { name: string; rhs: ts.Expression; node: ts.Node }[] = [];
    for (const id of this.referencesOf(sym)) {
      const p = id.parent;
      if (ts.isPropertyAccessExpression(p) && p.expression === id && isAssignmentTarget(p)) {
        out.push({ name: p.name.text, rhs: (p.parent as ts.BinaryExpression).right, node: p.parent });
      }
    }
    return out;
  }

  /** Identifiers with a given name (for JSX Provider lookups and the like). */
  identifiersNamed(name: string): readonly ts.Identifier[] {
    return this.byName.get(name) ?? [];
  }
}

function isAssignmentTarget(node: ts.Expression): boolean {
  const p = node.parent;
  if (!ts.isBinaryExpression(p) || p.left !== node) return false;
  const k = p.operatorToken.kind;
  return (
    k === ts.SyntaxKind.EqualsToken ||
    k === ts.SyntaxKind.BarBarEqualsToken ||
    k === ts.SyntaxKind.QuestionQuestionEqualsToken ||
    k === ts.SyntaxKind.AmpersandAmpersandEqualsToken
  );
}

function classifyUse(e: ts.Expression): CallableUse | undefined {
  let expr: ts.Node = e;
  while (ts.isParenthesizedExpression(expr.parent) || ts.isNonNullExpression(expr.parent)) expr = expr.parent;
  const p = expr.parent;
  if ((ts.isCallExpression(p) || ts.isNewExpression(p)) && p.expression === expr) return { kind: 'call', call: p };
  if ((ts.isJsxOpeningElement(p) || ts.isJsxSelfClosingElement(p)) && p.tagName === expr) return { kind: 'jsx', element: p };
  if (ts.isCallExpression(p)) {
    const argIndex = p.arguments.indexOf(expr as ts.Expression);
    if (argIndex >= 0) return { kind: 'callback', call: p, argIndex };
  }
  return undefined;
}

/** If `target` is assigned (directly or by destructuring), the right-hand side and path. */
function assignmentFor(target: ts.Expression): Assignment | undefined {
  if (isAssignmentTarget(target)) {
    const binary = target.parent as ts.BinaryExpression;
    return { rhs: binary.right, path: [], operator: binary.operatorToken.kind, binary };
  }
  // Destructuring: ({ a: target } = rhs), ({ target } = rhs), [target] = rhs
  const path: (string | number)[] = [];
  let node: ts.Node = target;
  for (let depth = 0; depth < 6; depth++) {
    const p: ts.Node = node.parent;
    if (ts.isShorthandPropertyAssignment(p) && p.name === node) {
      path.unshift(p.name.text);
      node = p.parent;
    } else if (ts.isPropertyAssignment(p) && p.initializer === node) {
      const key = propertyNameText(p.name);
      if (key === undefined) return undefined;
      path.unshift(key);
      node = p.parent;
    } else if (ts.isArrayLiteralExpression(p)) {
      path.unshift(p.elements.indexOf(node as ts.Expression));
      node = p;
    } else {
      return undefined;
    }
    if (!ts.isObjectLiteralExpression(node) && !ts.isArrayLiteralExpression(node)) return undefined;
    let outer: ts.Node = node;
    while (ts.isParenthesizedExpression(outer.parent)) outer = outer.parent;
    if (isAssignmentTarget(outer as ts.Expression)) {
      const binary = outer.parent as ts.BinaryExpression;
      return { rhs: binary.right, path, operator: binary.operatorToken.kind, binary };
    }
  }
  return undefined;
}

export function propertyNameText(name: ts.PropertyName): string | undefined {
  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name) || ts.isPrivateIdentifier(name)) return name.text;
  if (ts.isComputedPropertyName(name) && ts.isStringLiteralLike(name.expression)) return name.expression.text;
  return undefined;
}

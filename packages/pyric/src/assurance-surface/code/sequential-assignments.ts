/**
 * Structured sequential reassignment flow and read-position state resolution
 * for local variables, parameters, and destructured bindings.
 */
import ts from 'typescript';
import type { Evaluator } from './evaluator.js';
import type { Assignment } from './references.js';
import { alternatives, definiteTruthiness, NEVER, union, type AVal, type Env } from './values.js';

type FunctionLike = ts.SignatureDeclaration & { body?: ts.ConciseBody };

interface SequentialScope {
  readonly container: ts.Block | ts.SourceFile;
  readonly stmts: readonly ts.Statement[];
  readonly startIndex: number;
  readonly declFn: ts.Node | undefined;
}

interface SequentialPlan {
  readonly scope: SequentialScope;
  readonly minPos: number;
  readonly assignByStmt: ReadonlyMap<ts.ExpressionStatement, Assignment>;
}

function resolveSequentialScope(decl: ts.Declaration): SequentialScope | undefined {
  const declFn = ts.findAncestor(decl, ts.isFunctionLike);
  let rootDecl: ts.Node = decl;
  while (ts.isBindingElement(rootDecl)) {
    rootDecl = rootDecl.parent.parent;
  }
  if (ts.isVariableDeclaration(rootDecl)) {
    const varStmt = rootDecl.parent?.parent;
    if (!varStmt || !ts.isVariableStatement(varStmt)) return undefined;
    const parent = varStmt.parent;
    if (!ts.isBlock(parent) && !ts.isSourceFile(parent)) return undefined;
    const idx = parent.statements.indexOf(varStmt);
    if (idx < 0) return undefined;
    return { container: parent, stmts: parent.statements, startIndex: idx + 1, declFn };
  }
  if (ts.isParameter(rootDecl)) {
    const fn = rootDecl.parent as FunctionLike;
    if (!fn.body || !ts.isBlock(fn.body)) return undefined;
    return { container: fn.body, stmts: fn.body.statements, startIndex: 0, declFn };
  }
  return undefined;
}

function isStructuredAssignmentPath(stmt: ts.ExpressionStatement, container: ts.Block | ts.SourceFile): boolean {
  let cur: ts.Node = stmt;
  while (cur !== container) {
    const p = cur.parent;
    if (!p) return false;
    if (p === container) return true;
    if (ts.isBlock(p)) {
      cur = p;
      continue;
    }
    if (ts.isIfStatement(p) && (p.thenStatement === cur || p.elseStatement === cur)) {
      cur = p;
      continue;
    }
    return false;
  }
  return true;
}

function prepareSequentialPlan(
  decl: ts.Declaration,
  assigns: readonly Assignment[],
): SequentialPlan | undefined {
  const scope = resolveSequentialScope(decl);
  if (!scope) return undefined;
  let minPos = Number.POSITIVE_INFINITY;
  if (scope.startIndex < scope.stmts.length) {
    minPos = scope.stmts[scope.startIndex]!.pos;
  }
  const assignByStmt = new Map<ts.ExpressionStatement, Assignment>();
  for (const a of assigns) {
    if (a.path.length !== 0) return undefined;
    const parent = a.binary.parent;
    if (!ts.isExpressionStatement(parent) || parent.expression !== a.binary) return undefined;
    if (ts.findAncestor(a.binary, ts.isFunctionLike) !== scope.declFn) return undefined;
    if (a.binary.pos < minPos || a.binary.end > scope.container.end) return undefined;
    if (!isStructuredAssignmentPath(parent, scope.container)) return undefined;
    if (assignByStmt.has(parent)) return undefined;
    assignByStmt.set(parent, a);
  }
  return { scope, minPos, assignByStmt };
}

export function evalWithBinding(
  ev: Evaluator,
  sym: ts.Symbol,
  cur: AVal,
  expr: ts.Expression,
  env: Env | undefined,
): AVal {
  const stepEnv: Env = { bindings: new Map([[sym, cur]]), parent: env, stepSymbol: sym };
  const raw = ev.eval(expr, stepEnv);
  const forced = ev.force(raw);
  const retainsClosure = alternatives(forced).some((a) => a.k === 'fn');
  if (!retainsClosure) ev.clearEnv(stepEnv);
  return forced;
}

export function combineAssignmentValue(
  ev: Evaluator,
  cur: AVal,
  rhsVal: AVal,
  operator: ts.SyntaxKind,
  overwriteOnEquals: boolean,
): AVal {
  if (operator === ts.SyntaxKind.BarBarEqualsToken && overwriteOnEquals) {
    const kept = alternatives(ev.force(cur)).filter((alt) => definiteTruthiness(alt) !== false);
    return union([...kept, rhsVal]);
  }
  if (operator === ts.SyntaxKind.QuestionQuestionEqualsToken && overwriteOnEquals) {
    const kept = alternatives(ev.force(cur)).filter((alt) => alt.k !== 'null' && alt.k !== 'undefined');
    return union([...kept, rhsVal]);
  }
  if (operator === ts.SyntaxKind.AmpersandAmpersandEqualsToken && overwriteOnEquals) {
    const kept = alternatives(ev.force(cur)).filter((alt) => definiteTruthiness(alt) === false);
    return union([...kept, rhsVal]);
  }
  if (operator === ts.SyntaxKind.EqualsToken && overwriteOnEquals) {
    return rhsVal;
  }
  return union([cur, rhsVal]);
}

function stepSequentialStmt(
  ev: Evaluator,
  sym: ts.Symbol,
  stmt: ts.Statement,
  cur: AVal,
  assignByStmt: ReadonlyMap<ts.ExpressionStatement, Assignment>,
  env: Env | undefined,
  onRead?: (node: ts.Node, state: AVal) => void,
): { cur: AVal; terminated: boolean } {
  if (ts.isBlock(stmt)) {
    let blockCur = cur;
    for (const s of stmt.statements) {
      const res = stepSequentialStmt(ev, sym, s, blockCur, assignByStmt, env, onRead);
      blockCur = res.cur;
      if (res.terminated) return { cur: blockCur, terminated: true };
    }
    return { cur: blockCur, terminated: false };
  }
  if (ts.isExpressionStatement(stmt) && assignByStmt.has(stmt)) {
    const a = assignByStmt.get(stmt)!;
    const rhsVal = evalWithBinding(ev, sym, cur, a.rhs, env);
    return {
      cur: combineAssignmentValue(ev, cur, rhsVal, a.operator, true),
      terminated: false,
    };
  }
  if (ts.isIfStatement(stmt)) {
    if (onRead) onRead(stmt.expression, cur);
    const condVal = evalWithBinding(ev, sym, cur, stmt.expression, env);
    const t = definiteTruthiness(condVal);
    if (t === true) return stepSequentialStmt(ev, sym, stmt.thenStatement, cur, assignByStmt, env, onRead);
    if (t === false) {
      if (!stmt.elseStatement) return { cur, terminated: false };
      return stepSequentialStmt(ev, sym, stmt.elseStatement, cur, assignByStmt, env, onRead);
    }
    const thenRes = stepSequentialStmt(ev, sym, stmt.thenStatement, cur, assignByStmt, env, onRead);
    let elseRes: { cur: AVal; terminated: boolean } = { cur, terminated: false };
    if (stmt.elseStatement) {
      elseRes = stepSequentialStmt(ev, sym, stmt.elseStatement, cur, assignByStmt, env, onRead);
    }
    if (thenRes.terminated && elseRes.terminated) {
      return { cur: NEVER, terminated: true };
    }
    if (thenRes.terminated && !elseRes.terminated) {
      return { cur: elseRes.cur, terminated: false };
    }
    if (!thenRes.terminated && elseRes.terminated) {
      return { cur: thenRes.cur, terminated: false };
    }
    let ordered: AVal[] = [elseRes.cur, thenRes.cur];
    if (stmt.elseStatement) {
      ordered = [thenRes.cur, elseRes.cur];
    }
    return { cur: union(ordered), terminated: false };
  }
  if (onRead) onRead(stmt, cur);
  if (ts.isReturnStatement(stmt) || ts.isThrowStatement(stmt)) {
    return { cur, terminated: true };
  }
  return { cur, terminated: false };
}

export function trySequentialReassignments(
  ev: Evaluator,
  sym: ts.Symbol,
  decl: ts.Declaration,
  assigns: readonly Assignment[],
  initial: AVal,
  env: Env | undefined,
): AVal | undefined {
  const plan = prepareSequentialPlan(decl, assigns);
  if (!plan) return undefined;
  const { scope, assignByStmt } = plan;
  const allRefs = ev.refs.referencesOf(sym);
  const observed: AVal[] = [];
  const onRead = (node: ts.Node, state: AVal): void => {
    if (allRefs.some((id) => id.pos >= node.pos && id.end <= node.end)) {
      observed.push(state);
    }
  };
  let cur = initial;
  let terminated = false;
  for (let i = scope.startIndex; i < scope.stmts.length; i++) {
    const res = stepSequentialStmt(ev, sym, scope.stmts[i]!, cur, assignByStmt, env, onRead);
    cur = res.cur;
    if (res.terminated) {
      terminated = true;
      break;
    }
  }
  if (terminated) {
    if (observed.length > 0) return union(observed);
    return cur;
  }
  return union([...observed, cur]);
}

export function identifierSequentialValue(
  ev: Evaluator,
  sym: ts.Symbol,
  id: ts.Identifier,
  env: Env | undefined,
  resolveInitial: (decl: ts.Declaration) => AVal | undefined,
): AVal | undefined {
  const decl = sym.valueDeclaration ?? sym.declarations?.[0];
  if (!decl || (decl as { name?: ts.Node }).name === id) return undefined;
  const assigns = ev.refs.assignmentsTo(sym);
  if (assigns.length === 0) return undefined;
  if (ev.refs.propertyAssignments(sym).length > 0 || ev.refs.keyedElementAssignments(sym).length > 0) {
    return undefined;
  }
  const plan = prepareSequentialPlan(decl, assigns);
  if (!plan) return undefined;
  const { scope, minPos, assignByStmt } = plan;
  if (id.getSourceFile() !== scope.container.getSourceFile()) return undefined;
  if (id.pos < minPos || id.end > scope.container.end) return undefined;
  if (ts.findAncestor(id, ts.isFunctionLike) !== scope.declFn) {
    if (assigns.some((a) => a.binary.pos >= id.pos)) return undefined;
  }
  let guardKey = `iv${ev.idOf(sym)}:${ev.idOf(id)}`;
  if (env) guardKey = `${guardKey}:${ev.idOf(env)}`;
  let computed: AVal | undefined;
  const guarded = ev.guard(guardKey, () => {
    const initial = resolveInitial(decl);
    if (initial === undefined) return NEVER;
    const containsId = (node: ts.Node): boolean => id.pos >= node.pos && id.end <= node.end;
    const walkToId = (stmt: ts.Statement, cur: AVal): AVal | undefined => {
      if (ts.isBlock(stmt)) {
        let blockCur = cur;
        for (const s of stmt.statements) {
          if (containsId(s)) return walkToId(s, blockCur);
          const res = stepSequentialStmt(ev, sym, s, blockCur, assignByStmt, env);
          blockCur = res.cur;
          if (res.terminated) return NEVER;
        }
        return undefined;
      }
      if (ts.isExpressionStatement(stmt) && assignByStmt.has(stmt)) {
        const a = assignByStmt.get(stmt)!;
        if (containsId(a.rhs)) return cur;
        const rhsVal = evalWithBinding(ev, sym, cur, a.rhs, env);
        return combineAssignmentValue(ev, cur, rhsVal, a.operator, true);
      }
      if (ts.isIfStatement(stmt)) {
        if (containsId(stmt.expression)) return cur;
        const condVal = evalWithBinding(ev, sym, cur, stmt.expression, env);
        const t = definiteTruthiness(condVal);
        if (containsId(stmt.thenStatement)) {
          if (t === false) return NEVER;
          return walkToId(stmt.thenStatement, cur);
        }
        if (stmt.elseStatement && containsId(stmt.elseStatement)) {
          if (t === true) return NEVER;
          return walkToId(stmt.elseStatement, cur);
        }
        return undefined;
      }
      return cur;
    };
    let cur = initial;
    for (let i = scope.startIndex; i < scope.stmts.length; i++) {
      const stmt = scope.stmts[i]!;
      if (containsId(stmt)) {
        computed = walkToId(stmt, cur);
        return computed ?? NEVER;
      }
      const res = stepSequentialStmt(ev, sym, stmt, cur, assignByStmt, env);
      cur = res.cur;
      if (res.terminated) {
        computed = NEVER;
        return NEVER;
      }
    }
    return NEVER;
  });
  if (computed === undefined) {
    if (guarded.k === 'unknown') return guarded;
    return undefined;
  }
  return computed;
}

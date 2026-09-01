import type {
  FirestoreRules, MatchBlock, AllowRule, FunctionDef, Expression, Operation,
} from './FirestoreAST.js';
import { RULES_BUILTIN_FUNCTIONS } from './builtin-functions.js';

export interface ValidationFinding {
  code: string;
  severity: 'critical' | 'high' | 'medium' | 'low';
  path: string;
  operation?: string;
  message: string;
}

const WRITE_OPS: Set<Operation> = new Set(['write', 'create', 'update', 'delete']);
const READ_OPS: Set<Operation> = new Set(['read', 'get', 'list']);
const DATA_WRITE_OPS: Set<Operation> = new Set(['create', 'update']);

export function validateFirestoreRules(ast: FirestoreRules): ValidationFinding[] {
  const findings: ValidationFinding[] = [];
  const rootMatch = ast.service.match;

  // Collect all function names and calls
  const allFunctions = collectAllFunctions(rootMatch);
  const allCalls = collectAllCallsInRules(rootMatch);

  // SEC-4: Check for default deny
  checkDefaultDeny(rootMatch, findings);

  // QUA-3: Duplicate function names (production compile rejection — critical)
  checkDuplicateFunctions(rootMatch, findings);

  // QUA-4: Unused functions
  checkUnusedFunctions(rootMatch, allCalls, findings);

  // STR-3: Overlapping match paths
  checkOverlappingPaths(rootMatch.children, findings);

  // Walk all match blocks
  walkMatch(rootMatch, findings, allFunctions, rootMatch.functions);

  return findings;
}

function walkMatch(
  match: MatchBlock,
  findings: ValidationFinding[],
  allFunctions: Set<string>,
  scopeFunctions: FunctionDef[],
) {
  const isRecursiveWildcard = match.path.segments.some(s => s.type === 'recursive');
  const pathStr = match.path.raw;

  // Merge scope: parent functions + this match's functions
  const localScope = [...scopeFunctions, ...match.functions];

  for (const allow of match.allows) {
    const ops = allow.operations;
    // Fold semantically-constant conditions (e.g. `X || true`, `X && false`,
    // `!true`, ternaries with literal conditions) before the literal checks and
    // the auth/data-reference walks, so tautological rules can't evade SEC-1/2/3
    // and QUA-1 by being written as a binaryOp instead of a bare `true`/`false`.
    const cond = foldConstants(allow.condition);
    const isWrite = ops.some(op => WRITE_OPS.has(op));
    const isRead = ops.some(op => READ_OPS.has(op));
    const isDataWrite = ops.some(op => DATA_WRITE_OPS.has(op));
    const isLiteralTrue = cond.type === 'literal' && cond.value === true;
    const isLiteralFalse = cond.type === 'literal' && cond.value === false;
    const opStr = ops.join(', ');

    // SEC-1: Public write
    if (isWrite && isLiteralTrue) {
      findings.push({
        code: 'SEC-1', severity: 'critical', path: pathStr, operation: opStr,
        message: `Public write at ${pathStr} — anyone can ${opStr} without authentication`,
      });
    }

    // SEC-2: Public read at recursive wildcard
    if (isRead && isLiteralTrue && isRecursiveWildcard) {
      findings.push({
        code: 'SEC-2', severity: 'critical', path: pathStr, operation: opStr,
        message: `Public read at recursive wildcard ${pathStr} — entire database is readable`,
      });
    }

    // SEC-5: Overly permissive recursive wildcard
    if (isRecursiveWildcard && !isLiteralFalse) {
      findings.push({
        code: 'SEC-5', severity: 'high', path: pathStr, operation: opStr,
        message: `Recursive wildcard ${pathStr} has a non-deny rule — overrides all specific rules`,
      });
    }

    // SEC-3: No auth check on write (follows function calls transitively)
    const fnMap = new Map(localScope.map(f => [f.name, f]));
    if (isWrite && !isLiteralTrue && !isLiteralFalse && !referencesAuthTransitive(cond, fnMap)) {
      findings.push({
        code: 'SEC-3', severity: 'high', path: pathStr, operation: opStr,
        message: `Write rule at ${pathStr} does not check request.auth`,
      });
    }

    // SEC-6: Write without data validation (follows function calls transitively)
    if (isDataWrite && !isLiteralFalse && !referencesRequestDataTransitive(cond, fnMap)) {
      findings.push({
        code: 'SEC-6', severity: 'high', path: pathStr, operation: opStr,
        message: `${opStr} at ${pathStr} does not validate request.resource.data — any data shape accepted`,
      });
    }

    // SEM-1: request.resource.data in read rule
    if (isRead && !isWrite && referencesRequestData(cond)) {
      findings.push({
        code: 'SEM-1', severity: 'high', path: pathStr, operation: opStr,
        message: `Read rule at ${pathStr} references request.resource.data which is not available on reads`,
      });
    }

    // SEM-2: resource.data in create rule
    if (ops.includes('create') && !ops.includes('update') && referencesResourceData(cond)) {
      findings.push({
        code: 'SEM-2', severity: 'high', path: pathStr, operation: opStr,
        message: `Create rule at ${pathStr} references resource.data but document doesn't exist yet on create`,
      });
    }

    // SEM-3: document access budget exceeded. Production allows exactly 10
    // get/exists/getAfter/existsAfter reads per request evaluation; the
    // 11th fails, so the finding fires only ABOVE 10 (same boundary as the
    // linter's GET_COUNT error and the simulator's runtime LookupBudget).
    const docReads = countDocReads(cond, new Map(localScope.map(f => [f.name, f])));
    if (docReads > 10) {
      findings.push({
        code: 'SEM-3', severity: 'high', path: pathStr, operation: opStr,
        message: `Rule at ${pathStr} may perform ${docReads} document access calls (get/exists/getAfter/existsAfter) — exceeds the 10-call budget`,
      });
    }

    // SEM-4: Undefined function call
    const calls = collectFunctionCalls(cond);
    for (const fnName of calls) {
      if (!allFunctions.has(fnName) && !RULES_BUILTIN_FUNCTIONS.has(fnName)) {
        findings.push({
          code: 'SEM-4', severity: 'high', path: pathStr, operation: opStr,
          message: `Rule at ${pathStr} calls undefined function '${fnName}'`,
        });
      }
    }

    // QUA-1: Hardcoded true
    if (isLiteralTrue) {
      const severity = isWrite ? 'critical' as const : 'low' as const;
      findings.push({
        code: 'QUA-1', severity, path: pathStr, operation: opStr,
        message: `Hardcoded 'true' at ${pathStr} for ${opStr}`,
      });
    }

    // QUA-5: Complex condition
    if (exprDepth(cond) > 10) {
      findings.push({
        code: 'QUA-5', severity: 'low', path: pathStr, operation: opStr,
        message: `Condition at ${pathStr} has depth ${exprDepth(cond)} — consider splitting into functions`,
      });
    }
  }

  // QUA-2: Empty match block
  if (match.allows.length === 0 && match.children.length === 0 && match.functions.length === 0) {
    findings.push({
      code: 'QUA-2', severity: 'low', path: pathStr,
      message: `Match block at ${pathStr} is empty — no allows, children, or functions`,
    });
  }

  // STR-1: Match without wildcard
  if (match.path.segments.every(s => s.type === 'literal')) {
    findings.push({
      code: 'STR-1', severity: 'low', path: pathStr,
      message: `Match at ${pathStr} has no wildcard — matches exactly one document`,
    });
  }

  // STR-2: Nested match without parent rules (skip the root /databases match)
  const isRoot = match.path.raw.includes('databases') && match.path.raw.includes('documents');
  if (match.children.length > 0 && match.allows.length === 0 && !isRoot) {
    findings.push({
      code: 'STR-2', severity: 'medium', path: pathStr,
      message: `Match at ${pathStr} has nested children but no allows — parent collection is locked`,
    });
  }

  // Recurse into children
  for (const child of match.children) {
    walkMatch(child, findings, allFunctions, localScope);
  }
}

// ---- SEC-4: Default deny ----

function checkDefaultDeny(rootMatch: MatchBlock, findings: ValidationFinding[]) {
  const hasDefaultDeny = rootMatch.children.some(child => {
    const isRecursive = child.path.segments.some(s => s.type === 'recursive');
    if (!isRecursive) return false;
    return child.allows.some(a => {
      const hasBothOps = a.operations.includes('read') && a.operations.includes('write');
      const isDeny = a.condition.type === 'literal' && a.condition.value === false;
      return hasBothOps && isDeny;
    });
  });

  if (!hasDefaultDeny) {
    findings.push({
      code: 'SEC-4', severity: 'medium', path: '/',
      message: 'No default deny rule (match /{document=**} { allow read, write: if false; })',
    });
  }
}

// ---- Constant folding / simplification ----

function boolLiteral(value: boolean): Expression {
  return { type: 'literal', value, raw: String(value) };
}

function isLitBool(expr: Expression, value: boolean): boolean {
  return expr.type === 'literal' && expr.value === value;
}

/**
 * Simplify semantically-constant conditions so the literal checks and the
 * auth/data-reference walks operate on the reduced form. Recurses into nested
 * nodes so `X || (Y || true)` folds to `true`. Non-constant subexpressions are
 * preserved intact so the downstream walks still see real auth/data references.
 */
function foldConstants(expr: Expression): Expression {
  switch (expr.type) {
    case 'binaryOp': {
      const left = foldConstants(expr.left);
      const right = foldConstants(expr.right);
      if (expr.op === '||') {
        // X || true / true || X -> true
        if (isLitBool(left, true) || isLitBool(right, true)) return boolLiteral(true);
        // X || false / false || X -> X
        if (isLitBool(left, false)) return right;
        if (isLitBool(right, false)) return left;
      } else if (expr.op === '&&') {
        // X && false / false && X -> false
        if (isLitBool(left, false) || isLitBool(right, false)) return boolLiteral(false);
        // X && true / true && X -> X
        if (isLitBool(left, true)) return right;
        if (isLitBool(right, true)) return left;
      }
      return { type: 'binaryOp', op: expr.op, left, right };
    }
    case 'unaryOp': {
      const operand = foldConstants(expr.operand);
      if (expr.op === '!' && operand.type === 'literal' && typeof operand.value === 'boolean') {
        return boolLiteral(!operand.value);
      }
      return { type: 'unaryOp', op: expr.op, operand };
    }
    case 'ternary': {
      const condition = foldConstants(expr.condition);
      const consequent = foldConstants(expr.consequent);
      const alternate = foldConstants(expr.alternate);
      // Literal condition -> the taken branch
      if (condition.type === 'literal' && typeof condition.value === 'boolean') {
        return condition.value ? consequent : alternate;
      }
      return { type: 'ternary', condition, consequent, alternate };
    }
    default:
      return expr;
  }
}

// ---- Expression tree walkers ----

function referencesAuth(expr: Expression): boolean {
  return exprContains(expr, e =>
    e.type === 'memberAccess' && e.property === 'auth' &&
    e.object.type === 'identifier' && e.object.name === 'request',
  );
}

function referencesAuthTransitive(expr: Expression, fns: Map<string, FunctionDef>, visited = new Set<string>()): boolean {
  if (referencesAuth(expr)) return true;
  // Follow function calls
  let found = false;
  walkExpr(expr, e => {
    if (found) return;
    if (e.type === 'functionCall' && fns.has(e.name) && !visited.has(e.name)) {
      visited.add(e.name);
      if (referencesAuthTransitive(fns.get(e.name)!.body, fns, visited)) found = true;
    }
  });
  return found;
}

function referencesRequestData(expr: Expression): boolean {
  return exprContains(expr, e =>
    e.type === 'memberAccess' && e.property === 'data' &&
    e.object.type === 'memberAccess' && e.object.property === 'resource' &&
    e.object.object.type === 'identifier' && e.object.object.name === 'request',
  );
}

function referencesRequestDataTransitive(expr: Expression, fns: Map<string, FunctionDef>, visited = new Set<string>()): boolean {
  if (referencesRequestData(expr)) return true;
  let found = false;
  walkExpr(expr, e => {
    if (found) return;
    if (e.type === 'functionCall' && fns.has(e.name) && !visited.has(e.name)) {
      visited.add(e.name);
      if (referencesRequestDataTransitive(fns.get(e.name)!.body, fns, visited)) found = true;
    }
  });
  return found;
}

function referencesResourceData(expr: Expression): boolean {
  return exprContains(expr, e =>
    e.type === 'memberAccess' && e.property === 'data' &&
    e.object.type === 'identifier' && e.object.name === 'resource',
  );
}

/**
 * T2.1 — count document access calls (get/exists/getAfter/existsAfter)
 * reachable from a rule condition, expanding each user-defined function
 * once PER CALL SITE. `isOwner(a) && isOwner(b) && isOwner(c)` with 3 gets
 * inside `isOwner` costs 9, matching production where each call performs
 * its own reads (different arguments → different paths). `callStack` is an
 * on-stack recursion guard only — entries are removed on unwind so sibling
 * call sites each pay full price (the old shared, never-unwound set counted
 * every helper once per RULE, a systematic under-count). A function's `let`
 * bindings evaluate on every call, so their reads count too.
 *
 * This is a static over-approximation: production caches repeated reads of
 * the SAME path within a request (they don't recount — see
 * site-docs secure/firestore-rules-limits.md), but path identity is not
 * decidable statically, so every call site is charged. The runtime
 * simulator (LookupBudget in simulator/document-lookups.ts) applies the
 * cache-aware distinct-path count.
 */
function countDocReads(expr: Expression, functions: Map<string, FunctionDef>, callStack = new Set<string>()): number {
  let count = 0;
  walkExpr(expr, e => {
    if (e.type !== 'functionCall') return;
    if (e.name === 'get' || e.name === 'exists' || e.name === 'getAfter' || e.name === 'existsAfter') {
      count++;
      return;
    }
    // Follow user-defined function calls — once per call site.
    const fn = functions.get(e.name);
    if (fn && !callStack.has(e.name)) {
      callStack.add(e.name);
      for (const binding of fn.lets) {
        count += countDocReads(binding.value, functions, callStack);
      }
      count += countDocReads(fn.body, functions, callStack);
      callStack.delete(e.name); // unwind so the next call site counts again
    }
  });
  return count;
}

function collectFunctionCalls(expr: Expression): string[] {
  const calls: string[] = [];
  walkExpr(expr, e => {
    if (e.type === 'functionCall') calls.push(e.name);
  });
  return calls;
}

function collectAllFunctions(match: MatchBlock): Set<string> {
  const names = new Set<string>();
  function walk(m: MatchBlock) {
    for (const fn of m.functions) names.add(fn.name);
    for (const child of m.children) walk(child);
  }
  walk(match);
  return names;
}

// ---- QUA-3: Duplicate functions ----
//
// T2.4C — production REJECTS duplicate function declarations at compile
// time, so this is severity 'critical': the write gate
// (`write/handler.ts`) blocks only critical validator findings, and
// 'medium' folded to a mere warning that deployed anyway. The scope is
// the MERGED lexical scope (every ancestor match block plus the current
// one), matching evaluation scoping at `walkMatch`'s `localScope`:
// production rejects a child-block redefinition of a parent-scope
// function, not just two siblings in one block.
//
// The code stays QUA-3 (already registered and asserted by consumers);
// `DUPLICATE_FUNCTION` was considered and rejected — the module
// resolver already uses that name for its own error code
// (`modules/resolver-core.ts`), and colliding would make mixed issue
// lists ambiguous.

function checkDuplicateFunctions(match: MatchBlock, findings: ValidationFinding[]) {
  checkDupsInScope(match, new Set<string>(), findings);
}

function checkDupsInScope(match: MatchBlock, inherited: ReadonlySet<string>, findings: ValidationFinding[]) {
  const path = match.path.raw;
  const local = new Set<string>();
  for (const fn of match.functions) {
    if (local.has(fn.name)) {
      findings.push({
        code: 'QUA-3', severity: 'critical', path,
        message: `Duplicate function '${fn.name}' in scope at ${path} — production rejects duplicate function declarations at compile time`,
      });
    } else if (inherited.has(fn.name)) {
      findings.push({
        code: 'QUA-3', severity: 'critical', path,
        message: `Function '${fn.name}' at ${path} redeclares a function from an enclosing match scope — production rejects duplicate function declarations at compile time`,
      });
    }
    local.add(fn.name);
  }
  const merged = new Set([...inherited, ...local]);
  for (const child of match.children) checkDupsInScope(child, merged, findings);
}

// ---- QUA-4: Unused functions ----

function checkUnusedFunctions(rootMatch: MatchBlock, allCalls: Set<string>, findings: ValidationFinding[]) {
  function walk(match: MatchBlock) {
    for (const fn of match.functions) {
      if (!allCalls.has(fn.name)) {
        findings.push({
          code: 'QUA-4', severity: 'low', path: match.path.raw,
          message: `Function '${fn.name}' is defined but never called`,
        });
      }
    }
    for (const child of match.children) walk(child);
  }
  walk(rootMatch);
}

function collectAllCallsInRules(match: MatchBlock): Set<string> {
  const calls = new Set<string>();
  function walkM(m: MatchBlock) {
    for (const allow of m.allows) {
      for (const name of collectFunctionCalls(allow.condition)) calls.add(name);
    }
    for (const fn of m.functions) {
      for (const name of collectFunctionCalls(fn.body)) calls.add(name);
    }
    for (const child of m.children) walkM(child);
  }
  walkM(match);
  return calls;
}

// ---- STR-3: Overlapping paths ----

function checkOverlappingPaths(siblings: MatchBlock[], findings: ValidationFinding[]) {
  for (let i = 0; i < siblings.length; i++) {
    for (let j = i + 1; j < siblings.length; j++) {
      if (pathsOverlap(siblings[i], siblings[j])) {
        findings.push({
          code: 'STR-3', severity: 'low', path: siblings[i].path.raw,
          message: `Match paths '${siblings[i].path.raw}' and '${siblings[j].path.raw}' may overlap — the more permissive one wins`,
        });
      }
    }
    // Recurse into each sibling's children
    checkOverlappingPaths(siblings[i].children, findings);
  }
}

function pathsOverlap(a: MatchBlock, b: MatchBlock): boolean {
  const segsA = a.path.segments;
  const segsB = b.path.segments;
  if (segsA.length !== segsB.length) return false;
  // If one has a wildcard and the other has a literal at the same position, they overlap
  for (let i = 0; i < segsA.length; i++) {
    const sa = segsA[i], sb = segsB[i];
    if (sa.type === 'literal' && sb.type === 'literal' && sa.value !== sb.value) return false;
    // wildcard + literal at same position = overlap
    if ((sa.type === 'wildcard' || sa.type === 'recursive') && sb.type === 'literal') return true;
    if (sa.type === 'literal' && (sb.type === 'wildcard' || sb.type === 'recursive')) return true;
  }
  return false;
}

// ---- Expression depth ----

function exprDepth(expr: Expression): number {
  switch (expr.type) {
    case 'binaryOp': return 1 + Math.max(exprDepth(expr.left), exprDepth(expr.right));
    case 'unaryOp': return 1 + exprDepth(expr.operand);
    case 'ternary': return 1 + Math.max(exprDepth(expr.condition), exprDepth(expr.consequent), exprDepth(expr.alternate));
    case 'methodCall': return 1 + Math.max(exprDepth(expr.object), ...expr.args.map(exprDepth));
    case 'functionCall': return 1 + Math.max(0, ...expr.args.map(exprDepth));
    case 'bracketAccess': return 1 + Math.max(exprDepth(expr.object), exprDepth(expr.index));
    case 'sliceAccess': return 1 + Math.max(exprDepth(expr.object), exprDepth(expr.start), exprDepth(expr.end));
    case 'memberAccess': return 1 + exprDepth(expr.object);
    case 'inExpr': return 1 + Math.max(exprDepth(expr.element), exprDepth(expr.collection));
    case 'isExpr': return 1 + exprDepth(expr.value);
    default: return 0;
  }
}

// ---- Generic expression walker ----

function exprContains(expr: Expression, predicate: (e: Expression) => boolean): boolean {
  if (predicate(expr)) return true;
  return walkExprSome(expr, predicate);
}

function walkExprSome(expr: Expression, predicate: (e: Expression) => boolean): boolean {
  switch (expr.type) {
    case 'binaryOp': return exprContains(expr.left, predicate) || exprContains(expr.right, predicate);
    case 'unaryOp': return exprContains(expr.operand, predicate);
    case 'ternary': return exprContains(expr.condition, predicate) || exprContains(expr.consequent, predicate) || exprContains(expr.alternate, predicate);
    case 'methodCall': return exprContains(expr.object, predicate) || expr.args.some(a => exprContains(a, predicate));
    case 'functionCall': return expr.args.some(a => exprContains(a, predicate));
    case 'bracketAccess': return exprContains(expr.object, predicate) || exprContains(expr.index, predicate);
    case 'sliceAccess': return exprContains(expr.object, predicate) || exprContains(expr.start, predicate) || exprContains(expr.end, predicate);
    case 'memberAccess': return exprContains(expr.object, predicate);
    case 'inExpr': return exprContains(expr.element, predicate) || exprContains(expr.collection, predicate);
    case 'isExpr': return exprContains(expr.value, predicate);
    case 'listLiteral': return expr.elements.some(e => exprContains(e, predicate));
    case 'mapLiteral': return expr.entries.some(e => exprContains(e.key, predicate) || exprContains(e.value, predicate));
    default: return false;
  }
}

function walkExpr(expr: Expression, visitor: (e: Expression) => void) {
  visitor(expr);
  switch (expr.type) {
    case 'binaryOp': walkExpr(expr.left, visitor); walkExpr(expr.right, visitor); break;
    case 'unaryOp': walkExpr(expr.operand, visitor); break;
    case 'ternary': walkExpr(expr.condition, visitor); walkExpr(expr.consequent, visitor); walkExpr(expr.alternate, visitor); break;
    case 'methodCall': walkExpr(expr.object, visitor); expr.args.forEach(a => walkExpr(a, visitor)); break;
    case 'functionCall': expr.args.forEach(a => walkExpr(a, visitor)); break;
    case 'bracketAccess': walkExpr(expr.object, visitor); walkExpr(expr.index, visitor); break;
    case 'sliceAccess': walkExpr(expr.object, visitor); walkExpr(expr.start, visitor); walkExpr(expr.end, visitor); break;
    case 'memberAccess': walkExpr(expr.object, visitor); break;
    case 'inExpr': walkExpr(expr.element, visitor); walkExpr(expr.collection, visitor); break;
    case 'isExpr': walkExpr(expr.value, visitor); break;
    case 'listLiteral': expr.elements.forEach(e => walkExpr(e, visitor)); break;
    case 'mapLiteral': expr.entries.forEach(e => { walkExpr(e.key, visitor); walkExpr(e.value, visitor); }); break;
  }
}

import type {
  FirestoreRules, MatchBlock, AllowRule, FunctionDef, Expression, Operation, PathSegment,
} from './FirestoreAST.js';
import { countDocumentAccessCalls } from './document-access-count.js';
import { compileLimitViolations } from './compile-limits.js';
import { recursiveScope } from './recursive-scope.js';
import {
  collectRulesetScopes, expandFunctionBody, exprContains, exprDepth,
  functionReferences, ruleReferences, walkExpr,
  type NameReferences, type RulesetScopes,
} from './function-scopes.js';

export interface ValidationFinding {
  code: string;
  severity: 'critical' | 'high' | 'medium' | 'low';
  path: string;
  operation?: string;
  message: string;
}

const WRITE_OPS: Set<Operation> = new Set(['write', 'create', 'update', 'delete']);
const READ_OPS: Set<Operation> = new Set(['read', 'get', 'list']);
const DATA_WRITE_OPS: Set<Operation> = new Set(['write', 'create', 'update']);

const IMPORTED_AUTH_HELPERS: ReadonlySet<string> = new Set([
  'isAuthenticated',
  'isSignedIn',
  'isOwner',
  'isVerified',
  'hasClaim',
  'hasRole',
  'hasAnyRole',
]);

export function validateFirestoreRules(ast: FirestoreRules): ValidationFinding[] {
  const findings: ValidationFinding[] = [];
  const rootMatch = ast.service.match;
  const isStorage = ast.service?.name === 'firebase.storage';

  const importedAuthFns = new Set<string>();
  for (const imp of ast.imports ?? []) {
    const names = imp.functions ?? (imp as { names?: string[] }).names ?? [];
    for (const name of names) {
      if (IMPORTED_AUTH_HELPERS.has(name)) importedAuthFns.add(name);
    }
  }

  // Global and service scope functions are visible in every match block.
  const outerScope = [...(ast.functions ?? []), ...(ast.service.functions ?? [])];
  const scopes = collectRulesetScopes(ast);
  const fnScopes = new Map<FunctionDef, ReadonlyMap<string, FunctionDef>>(
    scopes.functions.map(s => [s.fn, s.functions]),
  );

  // SEC-4: Check for default deny
  checkDefaultDeny(rootMatch, findings);

  // QUA-3: Duplicate function names in one scope (production compile
  // rejection, so critical). Nested shadowing is legal and is not flagged.
  checkDuplicateFunctions(ast, findings);

  // SEM-4, SEM-5, QUA-4: names resolved by declaration scope
  checkNameResolution(scopes, findings);

  // STR-3: Overlapping match paths
  checkOverlappingPaths(rootMatch.children, findings);

  // Walk all match blocks
  walkMatch(rootMatch, findings, outerScope, fnScopes, null, isStorage, importedAuthFns);

  return findings;
}

function walkMatch(
  match: MatchBlock,
  findings: ValidationFinding[],
  scopeFunctions: FunctionDef[],
  fnScopes: ReadonlyMap<FunctionDef, ReadonlyMap<string, FunctionDef>>,
  /** Full path segments of the enclosing blocks below the documents root;
   *  null for the documents root itself. */
  parentSegments: readonly PathSegment[] | null = null,
  isStorage = false,
  importedAuthFns: ReadonlySet<string> = new Set(),
) {
  const segments = parentSegments === null ? [] : [...parentSegments, ...match.path.segments];
  // SEC-2 and SEC-5 concern a recursive wildcard in the last position, which
  // governs every document under its prefix. One followed by further
  // segments, the collection-group shape, governs only documents whose path
  // ends in them.
  const subtree = recursiveScope(segments);
  const recursiveSubtree = subtree?.kind === 'subtree' ? subtree : null;
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

    // SEC-2: Public read at a final recursive wildcard
    if (isRead && isLiteralTrue && recursiveSubtree) {
      findings.push({
        code: 'SEC-2', severity: 'critical', path: pathStr, operation: opStr,
        message: `Public read at ${recursiveSubtree.fullPath}: ${recursiveSubtree.description} is readable`,
      });
    }

    // SEC-5: A grant at a final recursive wildcard
    if (recursiveSubtree && !isLiteralFalse) {
      findings.push({
        code: 'SEC-5', severity: 'high', path: pathStr, operation: opStr,
        message: `Recursive wildcard ${recursiveSubtree.fullPath} grants ${opStr} on ${recursiveSubtree.description} `
          + 'when its condition holds; a request is allowed when any matching rule allows it, '
          + 'so a more specific rule cannot narrow this grant',
      });
    }

    // SEC-3: No auth check on write (follows function calls transitively)
    const fnMap = new Map(localScope.map(f => [f.name, f]));
    if (isWrite && !isLiteralTrue && !isLiteralFalse && !guardsAuthTransitive(cond, fnMap, fnScopes, importedAuthFns)) {
      findings.push({
        code: 'SEC-3', severity: 'high', path: pathStr, operation: opStr,
        message: `Write rule (${opStr}) at ${pathStr} does not check request.auth`,
      });
    }

    // SEC-6: Write without data validation (follows function calls transitively)
    if (isDataWrite && !isLiteralFalse && !validatesRequestDataTransitive(cond, fnMap, fnScopes, isStorage)) {
      findings.push({
        code: 'SEC-6', severity: 'high', path: pathStr, operation: opStr,
        message: isStorage
          ? `${opStr} at ${pathStr} does not validate request.resource — any upload payload accepted`
          : `${opStr} at ${pathStr} does not validate request.resource.data — any data shape accepted`,
      });
    }

    // SEM-1: request.resource.data in read rule (use unfolded condition so short-circuit folding does not hide dead reads)
    if (isRead && referencesRequestDataAnyTransitive(allow.condition, fnMap, fnScopes)) {
      findings.push({
        code: 'SEM-1', severity: 'high', path: pathStr, operation: opStr,
        message: `Read rule at ${pathStr} references request.resource.data which is not available on reads`,
      });
    }

    // SEM-2: resource.data in create/write rule
    const includesCreate = ops.includes('create') || ops.includes('write');
    if (includesCreate && !ops.includes('update') && referencesResourceDataAnyTransitive(allow.condition, fnMap, fnScopes)) {
      findings.push({
        code: 'SEM-2', severity: 'high', path: pathStr, operation: opStr,
        message: `Create rule at ${pathStr} references resource.data but document doesn't exist yet on create`,
      });
    }

    // SEM-3: document access budget exceeded. Production allows exactly 10
    // get/exists/getAfter/existsAfter reads per request evaluation in Firestore
    // and 2 firestore.get/firestore.exists reads in Storage; the next one
    // fails, so the finding fires only ABOVE the limit.
    const maxDocReads = isStorage ? 2 : 10;
    const docReads = countDocumentAccessCalls(allow.condition, fnMap, new Set(), fnScopes);
    if (docReads > maxDocReads) {
      findings.push({
        code: 'SEM-3', severity: 'high', path: pathStr, operation: opStr,
        message: isStorage
          ? `Rule at ${pathStr} may perform ${docReads} document access calls (firestore.get/firestore.exists), which exceeds the ${maxDocReads}-call budget`
          : `Rule at ${pathStr} may perform ${docReads} document access calls (get/exists/getAfter/existsAfter), which exceeds the ${maxDocReads}-call budget`,
      });
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
    if (exprDepth(allow.condition) > 10) {
      findings.push({
        code: 'QUA-5', severity: 'low', path: pathStr, operation: opStr,
        message: `Condition at ${pathStr} has depth ${exprDepth(allow.condition)} — consider splitting into functions`,
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

  // STR-2: Nested match without parent rules (skip the root /databases or /b/{bucket}/o match)
  const isRoot =
    (match.path.raw.includes('databases') && match.path.raw.includes('documents')) ||
    (match.path.raw.includes('/b/') && match.path.raw.includes('/o'));
  if (match.children.length > 0 && match.allows.length === 0 && !isRoot) {
    findings.push({
      code: 'STR-2', severity: 'medium', path: pathStr,
      message: `Match at ${pathStr} has nested children but no allows — parent collection is locked`,
    });
  }

  // Recurse into children
  for (const child of match.children) {
    walkMatch(child, findings, localScope, fnScopes, segments, isStorage, importedAuthFns);
  }
}

// ---- SEC-4: Default deny ----

function checkDefaultDeny(rootMatch: MatchBlock, findings: ValidationFinding[]) {
  const coversDeny = (block: MatchBlock): boolean => {
    if (block.allows.length === 0) return false;
    const deniedOps = new Set<Operation>();
    for (const a of block.allows) {
      const folded = foldConstants(a.condition);
      if (folded.type !== 'literal' || folded.value !== false) return false;
      for (const op of a.operations) deniedOps.add(op);
    }
    const coversRead = deniedOps.has('read') || (deniedOps.has('get') && deniedOps.has('list'));
    const coversWrite =
      deniedOps.has('write') ||
      (deniedOps.has('create') && deniedOps.has('update') && deniedOps.has('delete'));
    return coversRead && coversWrite;
  };

  const isRootWithTrailingRecursive =
    ((rootMatch.path.raw.includes('databases') && rootMatch.path.raw.includes('documents')) ||
      (rootMatch.path.raw.includes('/b/') && rootMatch.path.raw.includes('/o'))) &&
    rootMatch.path.segments.length > 0 &&
    rootMatch.path.segments[rootMatch.path.segments.length - 1]?.type === 'recursive';

  const hasDefaultDeny =
    (isRootWithTrailingRecursive && coversDeny(rootMatch)) ||
    rootMatch.children.some(child => {
      const isWholeDbWildcard =
        child.path.segments.length === 1 && child.path.segments[0].type === 'recursive';
      return isWholeDbWildcard && coversDeny(child);
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

/** Every expression a function evaluates: each let value, then the return expression. */
function functionExpressions(fn: FunctionDef): Expression[] {
  return [...fn.lets.map(l => l.value), fn.body];
}

function propTarget(expr: Expression, prop: string): Expression | null {
  if (expr.type === 'memberAccess' && expr.property === prop) return expr.object;
  if (expr.type === 'bracketAccess' && expr.index.type === 'literal' && expr.index.value === prop) {
    return expr.object;
  }
  return null;
}

function isRequestAuth(e: Expression): boolean {
  const obj = propTarget(e, 'auth');
  return obj !== null && obj.type === 'identifier' && obj.name === 'request';
}

function isRequestResource(e: Expression): boolean {
  const reqObj = propTarget(e, 'resource');
  return reqObj !== null && reqObj.type === 'identifier' && reqObj.name === 'request';
}

function isRequestResourceData(e: Expression): boolean {
  const resObj = propTarget(e, 'data');
  if (!resObj) return false;
  return isRequestResource(resObj);
}

function isResourceData(e: Expression): boolean {
  const obj = propTarget(e, 'data');
  return obj !== null && obj.type === 'identifier' && obj.name === 'resource';
}

function isNullLiteral(e: Expression): boolean {
  return e.type === 'literal' && e.value === null;
}

function isAuthComparisonWithNull(e: Expression, op: '==' | '!='): boolean {
  if (e.type !== 'binaryOp' || e.op !== op) return false;
  return (
    (isRequestAuth(e.left) && isNullLiteral(e.right)) ||
    (isNullLiteral(e.left) && isRequestAuth(e.right))
  );
}

function guardsConditionTransitive(
  expr: Expression,
  checkAtom: (e: Expression) => boolean | null,
  fns: ReadonlyMap<string, FunctionDef>,
  fnScopes: ReadonlyMap<FunctionDef, ReadonlyMap<string, FunctionDef>>,
  visited = new Set<FunctionDef>(),
): boolean {
  if (expr.type === 'binaryOp' && expr.op === '||') {
    return (
      guardsConditionTransitive(expr.left, checkAtom, fns, fnScopes, visited) &&
      guardsConditionTransitive(expr.right, checkAtom, fns, fnScopes, visited)
    );
  }
  if (expr.type === 'binaryOp' && expr.op === '&&') {
    return (
      guardsConditionTransitive(expr.left, checkAtom, fns, fnScopes, visited) ||
      guardsConditionTransitive(expr.right, checkAtom, fns, fnScopes, visited)
    );
  }
  if (expr.type === 'ternary') {
    const condGuards = guardsConditionTransitive(expr.condition, checkAtom, fns, fnScopes, visited);
    const thenGuards = condGuards || guardsConditionTransitive(expr.consequent, checkAtom, fns, fnScopes, visited);
    if (isLitBool(expr.alternate, false)) return thenGuards;
    const elseGuards = guardsConditionTransitive(expr.alternate, checkAtom, fns, fnScopes, visited);
    if (isLitBool(expr.consequent, false)) return elseGuards;
    return thenGuards && elseGuards;
  }
  const atomResult = checkAtom(expr);
  if (atomResult !== null) return atomResult;

  let found = false;
  walkExpr(expr, e => {
    if (found || e.type !== 'functionCall') return;
    const fn = fns.get(e.name);
    if (!fn || visited.has(fn)) return;
    const nextVisited = new Set(visited);
    nextVisited.add(fn);
    const calleeScope = fnScopes.get(fn) ?? fns;
    if (guardsConditionTransitive(expandFunctionBody(fn), checkAtom, calleeScope, fnScopes, nextVisited)) {
      found = true;
    }
  });
  return found;
}

function checkAuthAtom(
  expr: Expression,
  fns: ReadonlyMap<string, FunctionDef>,
  importedAuthFns: ReadonlySet<string>,
): boolean | null {
  if (expr.type === 'unaryOp' && expr.op === '!') {
    if (isAuthComparisonWithNull(expr.operand, '==')) return true;
    if (isAuthComparisonWithNull(expr.operand, '!=')) return false;
    return false;
  }
  if (isAuthComparisonWithNull(expr, '==')) return false;
  if (exprContains(expr, isRequestAuth)) return true;
  if (
    importedAuthFns.size > 0 &&
    exprContains(expr, e => e.type === 'functionCall' && !fns.has(e.name) && importedAuthFns.has(e.name))
  ) {
    return true;
  }
  return null;
}

function checkRequestDataAtom(expr: Expression, isStorage = false): boolean | null {
  if (exprContains(expr, isStorage ? isRequestResource : isRequestResourceData)) return true;
  return null;
}

function guardsAuthTransitive(
  expr: Expression,
  fns: ReadonlyMap<string, FunctionDef>,
  fnScopes: ReadonlyMap<FunctionDef, ReadonlyMap<string, FunctionDef>>,
  importedAuthFns: ReadonlySet<string> = new Set(),
): boolean {
  return guardsConditionTransitive(expr, e => checkAuthAtom(e, fns, importedAuthFns), fns, fnScopes);
}

function validatesRequestDataTransitive(
  expr: Expression,
  fns: ReadonlyMap<string, FunctionDef>,
  fnScopes: ReadonlyMap<FunctionDef, ReadonlyMap<string, FunctionDef>>,
  isStorage = false,
): boolean {
  return guardsConditionTransitive(expr, e => checkRequestDataAtom(e, isStorage), fns, fnScopes);
}

function referencesExprAnyTransitive(
  expr: Expression,
  pred: (e: Expression) => boolean,
  fns: ReadonlyMap<string, FunctionDef>,
  fnScopes: ReadonlyMap<FunctionDef, ReadonlyMap<string, FunctionDef>>,
  visited = new Set<FunctionDef>(),
): boolean {
  if (exprContains(expr, pred)) return true;
  let found = false;
  walkExpr(expr, e => {
    if (found || e.type !== 'functionCall') return;
    const fn = fns.get(e.name);
    if (!fn || visited.has(fn)) return;
    visited.add(fn);
    const calleeScope = fnScopes.get(fn) ?? fns;
    if (functionExpressions(fn).some(x => referencesExprAnyTransitive(x, pred, calleeScope, fnScopes, visited))) {
      found = true;
    }
  });
  return found;
}

function referencesRequestDataAnyTransitive(
  expr: Expression,
  fns: ReadonlyMap<string, FunctionDef>,
  fnScopes: ReadonlyMap<FunctionDef, ReadonlyMap<string, FunctionDef>>,
): boolean {
  return referencesExprAnyTransitive(expr, isRequestResourceData, fns, fnScopes);
}

function referencesResourceDataAnyTransitive(
  expr: Expression,
  fns: ReadonlyMap<string, FunctionDef>,
  fnScopes: ReadonlyMap<FunctionDef, ReadonlyMap<string, FunctionDef>>,
): boolean {
  return referencesExprAnyTransitive(expr, isResourceData, fns, fnScopes);
}

// ---- QUA-3: Duplicate functions ----
//
// Production REJECTS two declarations of one function name in the SAME
// scope at compile time, so this is severity 'critical': the write gate
// (`write/handler.ts`) blocks only critical validator findings, and
// 'medium' folded to a mere warning that deployed anyway.
//
// A scope is one declaration list: the global list above `service`, the
// list directly inside `service`, or one match block's own list. A nested
// match block that redeclares a name from an enclosing scope SHADOWS it and
// is legal: the simulator implements shadowing in
// `simulator/match-resolution.ts`, and the production capture in
// `conformance/rules-corpus/storage/function-scopes-and-shadowing.ts` pins
// inner-shadows-outer as accepted. Flagging that would block a ruleset
// production deploys.
//
// The code stays QUA-3 (already registered and asserted by consumers);
// `DUPLICATE_FUNCTION` was considered and rejected, because the module
// resolver already uses that name for its own error code
// (`modules/resolver-core.ts`), and colliding would make mixed issue
// lists ambiguous.
//
// Detection is the compile-limit module's FUNCTION_REDEFINED rejection, which
// the Firestore simulator and the Storage parser also enforce at load.

function checkDuplicateFunctions(ast: FirestoreRules, findings: ValidationFinding[]) {
  for (const violation of compileLimitViolations(ast)) {
    if (violation.code !== 'FUNCTION_REDEFINED') continue;
    findings.push({
      code: 'QUA-3', severity: 'critical', path: violation.scope ?? '',
      message: `${violation.message} Function '${violation.functionName}' is declared twice in ${violation.scope}, and production rejects the ruleset at compile time`,
    });
  }
}

// ---- SEM-4, SEM-5, QUA-4: name resolution ----
//
// Every rule condition and every function body resolves its names against
// the scopes in effect where it is declared (`function-scopes.ts`), not
// against every function in the ruleset. Production compiles an unresolved
// function or variable name with a warning ("Invalid function name: s.",
// "Invalid variable name: d.") and evaluating it is an error, so a rule
// that reaches it denies: SEM-4 and SEM-5 are high. A function that no
// resolved call reaches draws production's "Unused function: f." warning,
// at any scope: QUA-4 is low. A call from an unused function still counts,
// as it does in production.

function checkNameResolution(scopes: RulesetScopes, findings: ValidationFinding[]) {
  const called = new Set<FunctionDef>();
  const report = (refs: NameReferences, subject: string, path: string, operation?: string) => {
    for (const callee of refs.callees) called.add(callee);
    const op = operation === undefined ? {} : { operation };
    for (const name of refs.undefinedCalls) {
      findings.push({
        code: 'SEM-4', severity: 'high', path, ...op,
        message: `${subject} calls undefined function '${name}'`,
      });
    }
    for (const name of refs.unboundVariables) {
      findings.push({
        code: 'SEM-5', severity: 'high', path, ...op,
        message: `${subject} reads unbound variable '${name}'. No let binding, function parameter, path capture, or rules global has that name, so evaluating it is an error and the request is denied`,
      });
    }
  };
  for (const scoped of scopes.rules) {
    report(ruleReferences(scoped), `Rule at ${scoped.label}`, scoped.label, scoped.rule.operations.join(', '));
  }
  for (const scoped of scopes.functions) {
    report(functionReferences(scoped), `Function '${scoped.fn.name}' in ${scoped.label}`, scoped.label);
  }
  for (const scoped of scopes.functions) {
    if (called.has(scoped.fn)) continue;
    findings.push({
      code: 'QUA-4', severity: 'low', path: scoped.label,
      message: `Unused function '${scoped.fn.name}': no rule or function calls it`,
    });
  }
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

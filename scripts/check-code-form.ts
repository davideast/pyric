import ts from 'typescript';

export interface CodeFormIssue {
  rule: string;
  line: number;
  column: number;
}

export interface CodeFormExclusion {
  startLine: number;
  endLine: number;
  reason: 'unchanged-top-level-statement';
}

/** Check changed top-level statements in full, exposing every legacy exclusion. */
export function checkChangedCodeForm(input: { before?: string; after: string; fileName: string; program?: ts.Program }): {
  issues: CodeFormIssue[];
  excluded: CodeFormExclusion[];
} {
  const issues = checkCodeForm(input.after, input.fileName, input.program);
  const beforeSource = input.before;
  const isNewFile = beforeSource === undefined;
  if (isNewFile) return { issues, excluded: [] };

  const before = ts.createSourceFile(input.fileName, beforeSource, ts.ScriptTarget.Latest, true);
  const after = ts.createSourceFile(input.fileName, input.after, ts.ScriptTarget.Latest, true);
  const previousStatements = before.statements.map((statement) => statement.getText(before));
  const unchanged: { start: number; end: number }[] = [];
  for (const statement of after.statements) {
    const previousIndex = previousStatements.indexOf(statement.getText(after));
    const isUnchanged = previousIndex !== -1;
    if (isUnchanged) {
      previousStatements.splice(previousIndex, 1);
      unchanged.push({ start: statement.getStart(after), end: statement.getEnd() });
    }
  }
  const scopedIssues = issues.filter((issue) => {
    const isSyntaxError = issue.rule === 'syntax';
    if (isSyntaxError) return true;
    const position = after.getPositionOfLineAndCharacter(issue.line - 1, issue.column - 1);
    const isInScope = !unchanged.some((range) => position >= range.start && position < range.end);
    return isInScope;
  });
  const excluded = unchanged.map((range): CodeFormExclusion => ({
    startLine: after.getLineAndCharacterOfPosition(range.start).line + 1,
    endLine: after.getLineAndCharacterOfPosition(range.end - 1).line + 1,
    reason: 'unchanged-top-level-statement',
  }));
  return { issues: scopedIssues, excluded };
}

function unparenthesized(expression: ts.Expression): ts.Expression {
  const isParenthesized = ts.isParenthesizedExpression(expression);
  if (isParenthesized) return unparenthesized(expression.expression);
  return expression;
}

function isLogicalExpression(expression: ts.Expression): boolean {
  const isBinaryExpression = ts.isBinaryExpression(expression);
  if (isBinaryExpression) {
    const operator = expression.operatorToken.kind;
    return operator === ts.SyntaxKind.AmpersandAmpersandToken
      || operator === ts.SyntaxKind.BarBarToken
      || operator === ts.SyntaxKind.QuestionQuestionToken;
  }
  return false;
}

function containsChoice(node: ts.Node): boolean {
  const isChoice = ts.isConditionalExpression(node);
  if (isChoice) return true;
  return ts.forEachChild(node, containsChoice) ?? false;
}

/** Check syntax alone, or also decision types using the caller's compiled program. */
export function checkCodeForm(source: string, fileName = 'input.tsx', typedProgram?: ts.Program): CodeFormIssue[] {
  const file = typedProgram?.getSourceFile(fileName) ?? ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true);
  const isStaleSource = file.text !== source;
  if (isStaleSource) throw new Error(`Source changed while checking ${fileName}; rerun the code-form command.`);
  const options: ts.CompilerOptions = { noLib: true, noResolve: true };
  const host = ts.createCompilerHost(options);
  host.getSourceFile = (requestedFile) => {
    const isRequestedFile = requestedFile === file.fileName;
    return isRequestedFile ? file : undefined;
  };
  const program = typedProgram ?? ts.createProgram([file.fileName], options, host);
  const typeChecker = typedProgram?.getTypeChecker();
  const syntaxErrors = program.getSyntacticDiagnostics(file);
  const hasSyntaxErrors = syntaxErrors.length > 0;
  if (hasSyntaxErrors) {
    return syntaxErrors.map((diagnostic) => {
      const position = file.getLineAndCharacterOfPosition(diagnostic.start ?? 0);
      return { rule: 'syntax', line: position.line + 1, column: position.character + 1 };
    });
  }
  const issues: CodeFormIssue[] = [];

  function report(rule: string, node: ts.Node): void {
    const position = file.getLineAndCharacterOfPosition(node.getStart(file));
    issues.push({ rule, line: position.line + 1, column: position.character + 1 });
  }

  function checkDecision(expression: ts.Expression | undefined): void {
    const hasDecision = expression !== undefined;
    if (hasDecision) {
      const isInlineDecision = !ts.isIdentifier(expression);
      if (isInlineDecision) {
        report('named-condition', expression);
        return;
      }
      const hasTypes = typeChecker !== undefined;
      if (hasTypes) {
        const decisionType = typeChecker.getTypeAtLocation(expression);
        const hasUnprovenType = (decisionType.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown | ts.TypeFlags.Never)) !== 0;
        const hasInvalidDecisionType = hasUnprovenType || !typeChecker.isTypeAssignableTo(decisionType, typeChecker.getBooleanType());
        if (hasInvalidDecisionType) report('boolean-condition', expression);
      }
    }
  }

  function visit(node: ts.Node): void {
    const hasExpressionDecision = ts.isIfStatement(node) || ts.isWhileStatement(node) || ts.isDoStatement(node);
    const hasConditionDecision = ts.isForStatement(node) || ts.isConditionalExpression(node);
    const isJsxExpression = ts.isJsxExpression(node);
    const isChoice = ts.isConditionalExpression(node);
    const isSpread = ts.isSpreadAssignment(node);
    const isExpressionStatement = ts.isExpressionStatement(node);
    const isExplicitAny = node.kind === ts.SyntaxKind.AnyKeyword;
    const isNonNullAssertion = ts.isNonNullExpression(node);
    const isAssertion = ts.isAsExpression(node) || ts.isTypeAssertionExpression(node);
    if (isExplicitAny) report('explicit-any', node);
    if (isNonNullAssertion) report('non-null-assertion', node);
    if (isAssertion) {
      const expression = unparenthesized(node.expression);
      const isDoubleAssertion = ts.isAsExpression(expression) || ts.isTypeAssertionExpression(expression);
      if (isDoubleAssertion) report('double-assertion', node);
    }
    if (hasExpressionDecision) checkDecision(node.expression);
    if (hasConditionDecision) checkDecision(node.condition);
    if (isChoice) {
      const hasNestedChoice = containsChoice(node.condition) || containsChoice(node.whenTrue) || containsChoice(node.whenFalse);
      if (hasNestedChoice) report('nested-ternary', node);
    }
    if (isSpread) {
      const expression = unparenthesized(node.expression);
      const hasConditionalSpread = isLogicalExpression(expression) || ts.isConditionalExpression(expression);
      if (hasConditionalSpread) report('conditional-spread', node);
    }
    if (isExpressionStatement) {
      const hasLogicalSideEffect = isLogicalExpression(unparenthesized(node.expression));
      if (hasLogicalSideEffect) report('logical-side-effect', node);
    }
    if (isJsxExpression) {
      const expression = node.expression;
      const isBinaryExpression = expression !== undefined && ts.isBinaryExpression(expression);
      if (isBinaryExpression) {
        const isConditionalRendering = expression.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken;
        if (isConditionalRendering) checkDecision(expression.left);
      }
    }
    ts.forEachChild(node, visit);
  }

  visit(file);
  const checkedComments = new Set<number>();
  function checkComments(node: ts.Node): void {
    const comments = [
      ...ts.getLeadingCommentRanges(source, node.pos) ?? [],
      ...ts.getTrailingCommentRanges(source, node.end) ?? [],
    ];
    for (const comment of comments) {
      const wasChecked = checkedComments.has(comment.pos);
      if (wasChecked) continue;
      checkedComments.add(comment.pos);
      const text = source.slice(comment.pos, comment.end);
      const hasSuppression = /@ts-(ignore|expect-error|nocheck)\b|eslint-disable\b/.test(text);
      if (hasSuppression) {
        const position = file.getLineAndCharacterOfPosition(comment.pos);
        issues.push({ rule: 'suppression', line: position.line + 1, column: position.character + 1 });
      }
    }
    ts.forEachChild(node, checkComments);
  }
  checkComments(file);
  return issues;
}

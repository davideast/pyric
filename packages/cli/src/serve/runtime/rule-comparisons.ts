import type { ChipRequest } from './chip-traffic.js';

type Check = NonNullable<ChipRequest['rulesEvidence']>['rules'][number]['checks'][number];

function fieldLabel(expression: string): string {
  if (expression.startsWith('request.resource.data.')) return `Submitted ${expression.slice(22)}`;
  if (expression.startsWith('resource.data.')) return `Stored ${expression.slice(14)}`;
  if (expression === 'request.auth.uid') return 'Signed-in user';
  if (expression.startsWith('request.auth.token.')) return `User ${expression.slice(19)}`;
  return expression;
}

const requirements: Record<string, string> = {
  '==': 'Equals', '!=': 'Differs from',
  '>=': 'At least', '>': 'Greater than',
  '<=': 'At most', '<': 'Less than',
};

function hasAlternativeAncestor(index: number, checks: readonly Check[]): boolean {
  let parent = checks[index]?.parent;
  while (parent !== null && parent !== undefined && parent < index) {
    if (checks[parent]?.operator === '||') return true;
    index = parent;
    parent = checks[index]?.parent;
  }
  return false;
}

/** Uses captured AST operators and operand relationships, never parses rule text. */
export function failedComparisons(checks: readonly Check[]) {
  return checks.flatMap((check, index) => {
    if (check.state !== 'value' || check.value !== false || check.operator === undefined) return [];
    const requirement = requirements[check.operator];
    if (requirement === undefined) return [];
    const operands = checks.filter(candidate => candidate.parent === index);
    if (operands.length !== 2) return [];
    const [left, right] = operands;
    if (left?.state !== 'value' || right?.state !== 'value') return [];
    return [{
      alternative: hasAlternativeAncestor(index, checks),
      field: fieldLabel(left.expression), observed: JSON.stringify(left.value),
      requirement, expected: JSON.stringify(right.value),
      expectedField: right.kind === 'literal' ? null : fieldLabel(right.expression),
    }];
  });
}

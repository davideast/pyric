import { z } from 'zod';

export const RuleErrorSchema = z.object({
  code: z.string(),
  message: z.string(),
});

export const RuleLintSchema = z.object({
  code: z.string(),
  message: z.string(),
});

export const ParsedExpressionSchema = z.object({
  raw: z.string(),
  valid: z.boolean(),
  errors: z.array(RuleErrorSchema),
  warnings: z.array(RuleLintSchema),
  referencedIdentifiers: z.array(z.string()),
});

export const RtdbRuleExpressionSchema = z.object({
  raw: z.string(),
  parsed: ParsedExpressionSchema,
});

export type RuleError = z.infer<typeof RuleErrorSchema>;
export type RuleLint = z.infer<typeof RuleLintSchema>;
export type ParsedExpression = z.infer<typeof ParsedExpressionSchema>;
export type RtdbRuleExpression = z.infer<typeof RtdbRuleExpressionSchema>;

export type RtdbNode = {
  path: string;
  pathVariables: string[];
  read?: RtdbRuleExpression;
  write?: RtdbRuleExpression;
  validate?: RtdbRuleExpression;
  indexOn?: string[];
  /** Shape problems in the rules object this node came from; absent when it has none. */
  structure?: RtdbStructuralFinding[];
  children: RtdbNode[];
};

/** A problem in the shape of a rules object, found while compiling its node. */
export type RtdbStructuralFinding = {
  path: string;
  code:
    | 'MULTIPLE_WILDCARDS'
    | 'EXPECTED_OBJECT'
    | 'RULE_NOT_EXPRESSION'
    | 'INDEX_ON_SHAPE'
    | 'INVALID_KEY';
  message: string;
  /** `error` when a production deploy of this form has been captured; `warning` when the refusal is inferred from the deploy's message text. */
  severity: 'error' | 'warning';
};

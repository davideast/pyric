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
  children: RtdbNode[];
};

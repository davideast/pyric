import { z } from 'zod';

/** Identity for user-mode RTDB operations. When supplied to a data
 *  tool, the operation is performed AS this user with security rules
 *  enforced. Omit for admin access. */
export interface UserAuth {
  uid: string;
  claims?: Record<string, unknown>;
}

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
  exists: boolean;
  read?: RtdbRuleExpression;
  write?: RtdbRuleExpression;
  validate?: RtdbRuleExpression;
  indexOn?: string[];
  children: RtdbNode[];
};

export const RtdbIRSchema = z.object({
  service: z.literal('realtime-database'),
  databaseUrl: z.string().url(),
  rules: z.any(),
});
export type RtdbIR = z.infer<typeof RtdbIRSchema>;

export interface DataAuthOptions {
  auth?: UserAuth;
}

export interface RtdbTools {
  generateIR(): Promise<import('./ir/spec.js').GenerateIRResult>;
  simulate(input: unknown): import('./simulation/spec.js').SimulateResult;
  writeRules(ir: RtdbIR): Promise<import('./write/spec.js').WriteRulesResult>;
  crawlStructure(options?: import('./crawl/spec.js').CrawlOptions & DataAuthOptions): Promise<import('./crawl/spec.js').CrawlStructureResult>;
  readData(path: string, options?: DataAuthOptions): Promise<import('./data/spec.js').DataResult>;
  setData(path: string, data: unknown, options?: DataAuthOptions): Promise<import('./data/spec.js').DataResult>;
  updateData(path: string, data: Record<string, unknown>, options?: DataAuthOptions): Promise<import('./data/spec.js').DataResult>;
  pushData(path: string, data: unknown, options?: DataAuthOptions): Promise<import('./data/spec.js').DataResult>;
  removeData(path: string, options?: DataAuthOptions): Promise<import('./data/spec.js').DataResult>;
  validatedWrite(input: import('./data/spec.js').ValidatedWriteInput): Promise<import('./data/spec.js').ValidatedWriteResult>;
}

export type GenerateIRResult = import('./ir/spec.js').GenerateIRResult;
export type SimulateResult = import('./simulation/spec.js').SimulateResult;
export type SimulationInput = import('./simulation/spec.js').SimulationInput;
export type WriteRulesResult = import('./write/spec.js').WriteRulesResult;
export type CrawlStructureResult = import('./crawl/spec.js').CrawlStructureResult;
export type CrawlOptions = import('./crawl/spec.js').CrawlOptions;
export type StructureNode = import('./crawl/spec.js').StructureNode;

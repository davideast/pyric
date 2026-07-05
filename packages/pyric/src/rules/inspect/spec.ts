import type { FirestoreRules } from '../grammar/FirestoreAST.js';
import type { ValidationFinding } from '../grammar/FirestoreValidator.js';
import type { ParseError } from '../grammar/FirestoreParser.js';

export type InspectFirestoreRulesResult =
  | {
      success: true;
      data: {
        rules: FirestoreRules;
        source: string;
        rulesetId: string;
        createdAt: string;
        summary: RulesSummary;
        findings: ValidationFinding[];
      };
    }
  | {
      success: false;
      error: { code: string; message: string; recoverable: boolean; parseError?: ParseError };
    };

export interface RulesSummary {
  /** All match paths in the rules (e.g., '/users/{userId}', '/posts/{postId}') */
  matchPaths: string[];
  /** All function names defined in the rules */
  functionNames: string[];
  /** Count of allow rules by operation type */
  operationCounts: Record<string, number>;
  /** Total number of allow rules */
  totalAllowRules: number;
  /** Paths with public read (allow read: if true) */
  publicReadPaths: string[];
  /** Paths with public write (allow write: if true or allow create/update/delete: if true) */
  publicWritePaths: string[];
}

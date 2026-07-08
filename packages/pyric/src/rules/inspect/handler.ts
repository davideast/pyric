import type { ProjectScope } from '../../project-scope.js';
import type { InspectFirestoreRulesResult, RulesSummary } from './spec.js';
import type { MatchBlock, AllowRule, Expression } from '../grammar/FirestoreAST.js';
import { parseToASTOrError } from '../grammar/FirestoreParser.js';
import { validateFirestoreRules } from '../grammar/FirestoreValidator.js';

const RULES_API = 'https://firebaserules.googleapis.com/v1';

export class InspectFirestoreRulesHandler {
  async execute(scope: ProjectScope): Promise<InspectFirestoreRulesResult> {
    try {
      const token = await scope.resolveToken();

      // 1. List rulesets to find the latest Firestore ruleset
      const listRes = await fetch(`${RULES_API}/projects/${scope.projectId}/rulesets?pageSize=10`, {
        headers: { Authorization: `Bearer ${token}` },
      });

      if (listRes.status === 403) {
        return {
          success: false,
          error: { code: 'PERMISSION_DENIED', message: 'Service account lacks permission to read Firestore rules', recoverable: false },
        };
      }

      if (!listRes.ok) {
        return {
          success: false,
          error: { code: 'FETCH_FAILED', message: `Failed to list rulesets: ${listRes.status}`, recoverable: false },
        };
      }

      const listData = await listRes.json() as { rulesets?: Array<{ name: string; createTime: string; metadata?: { services?: string[] } }> };
      const rulesets = (listData.rulesets || []).filter(r =>
        r.metadata?.services?.includes('cloud.firestore'),
      );

      if (rulesets.length === 0) {
        return {
          success: false,
          error: { code: 'NO_RULESETS', message: 'No Firestore rulesets found for this project', recoverable: false },
        };
      }

      // 2. Get the most recent ruleset
      const latest = rulesets[0];
      const rulesetId = latest.name.split('/').pop()!;

      const getRes = await fetch(`${RULES_API}/${latest.name}`, {
        headers: { Authorization: `Bearer ${token}` },
      });

      if (!getRes.ok) {
        return {
          success: false,
          error: { code: 'FETCH_FAILED', message: `Failed to get ruleset: ${getRes.status}`, recoverable: false },
        };
      }

      const rulesetData = await getRes.json() as {
        source: { files: Array<{ name: string; content: string }> };
        createTime: string;
      };

      const source = rulesetData.source.files[0]?.content || '';

      // 3. Parse the rules — surface line/col so a deployed-but-broken
      // ruleset is easy to locate even when it came from outside this SDK.
      const parsed = parseToASTOrError(source);
      if (!parsed.ok) {
        return {
          success: false,
          error: {
            code: 'PARSE_FAILED',
            message: `Failed to parse deployed Firestore rules at line ${parsed.error.line}, col ${parsed.error.column}: expected ${parsed.error.expected || '<unknown>'}`,
            recoverable: false,
            parseError: parsed.error,
          },
        };
      }
      const ast = parsed.ast;

      // 4. Build summary + validate
      const summary = buildSummary(ast.service.match);
      const findings = validateFirestoreRules(ast);

      return {
        success: true,
        data: {
          rules: ast,
          source,
          rulesetId,
          createdAt: latest.createTime,
          summary,
          findings,
        },
      };
    } catch (e) {
      return {
        success: false,
        error: { code: 'FETCH_FAILED', message: e instanceof Error ? e.message : String(e), recoverable: false },
      };
    }
  }
}

function buildSummary(rootMatch: MatchBlock): RulesSummary {
  const matchPaths: string[] = [];
  const functionNames: string[] = [];
  const operationCounts: Record<string, number> = {};
  let totalAllowRules = 0;
  const publicReadPaths: string[] = [];
  const publicWritePaths: string[] = [];

  function walkMatch(match: MatchBlock) {
    // Collect match path
    matchPaths.push(match.path.raw);

    // Collect functions
    for (const fn of match.functions) {
      functionNames.push(fn.name);
    }

    // Collect allow rules
    for (const allow of match.allows) {
      totalAllowRules++;
      for (const op of allow.operations) {
        operationCounts[op] = (operationCounts[op] || 0) + 1;
      }

      // Check for public access (condition is literal true)
      if (isLiteralTrue(allow.condition)) {
        for (const op of allow.operations) {
          if (op === 'read' || op === 'get' || op === 'list') {
            if (!publicReadPaths.includes(match.path.raw)) {
              publicReadPaths.push(match.path.raw);
            }
          }
          if (op === 'write' || op === 'create' || op === 'update' || op === 'delete') {
            if (!publicWritePaths.includes(match.path.raw)) {
              publicWritePaths.push(match.path.raw);
            }
          }
        }
      }
    }

    // Recurse into children
    for (const child of match.children) {
      walkMatch(child);
    }
  }

  // Walk children of the documents match (skip the /databases/{database}/documents root)
  for (const fn of rootMatch.functions) {
    functionNames.push(fn.name);
  }
  for (const child of rootMatch.children) {
    walkMatch(child);
  }
  // Also count root-level allows
  for (const allow of rootMatch.allows) {
    totalAllowRules++;
    for (const op of allow.operations) {
      operationCounts[op] = (operationCounts[op] || 0) + 1;
    }
  }

  return { matchPaths, functionNames, operationCounts, totalAllowRules, publicReadPaths, publicWritePaths };
}

function isLiteralTrue(expr: Expression): boolean {
  return expr.type === 'literal' && expr.value === true;
}

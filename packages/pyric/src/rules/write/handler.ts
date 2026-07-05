import type { ProjectScope } from 'pyric-tools/deploy';
import type { WriteFirestoreRulesResult } from './spec.js';
import { parseToASTOrError } from '../grammar/FirestoreParser.js';
import { validateFirestoreRules } from '../grammar/FirestoreValidator.js';
import { lintFirestoreRules } from '../linter/linter.js';

const RULES_API = 'https://firebaserules.googleapis.com/v1';

export class WriteFirestoreRulesHandler {
  async execute(scope: ProjectScope, source: string): Promise<WriteFirestoreRulesResult> {
    // 1. Parse — surface line/col on failure so the caller (often an agent)
    // can locate the syntax error instead of getting an opaque PARSE_FAILED.
    const parsed = parseToASTOrError(source);
    if (!parsed.ok) {
      return {
        success: false,
        error: {
          code: 'PARSE_FAILED',
          message: `Failed to parse Firestore rules at line ${parsed.error.line}, col ${parsed.error.column}: expected ${parsed.error.expected || '<unknown>'}`,
          recoverable: true,
          parseError: parsed.error,
        },
      };
    }
    const ast = parsed.ast;

    // 2. Check version
    if (ast.version !== '2') {
      return {
        success: false,
        error: { code: 'PARSE_FAILED', message: `Unsupported rules_version '${ast.version}' — only version '2' is supported`, recoverable: true },
      };
    }

    // 3. Validate — surface security findings (SEC-1 public write, SEC-2
    // public read at recursive wildcard) before lint. The validator and
    // linter both catch `allow … if true`, so whichever runs first wins.
    // Validate wins because CRITICAL findings carry the security taxonomy
    // (SEC-1/SEC-2 codes, path+operation) that callers actually
    // remediate against; the linter's PERMISSIVE_RULE/RECURSIVE_WILDCARD
    // notes are stylistic and would mask the security signal if they
    // gated first. Compute lint first so its warnings ride along on
    // the CRITICAL response for completeness.
    const lint = lintFirestoreRules(source);
    const findings = validateFirestoreRules(ast);
    const critical = findings.filter(f => f.severity === 'critical');
    if (critical.length > 0) {
      return {
        success: false,
        error: {
          code: 'CRITICAL_FINDINGS',
          message: `${critical.length} critical finding(s) — fix before deploying`,
          recoverable: true,
          findings,
          lint,
        },
      };
    }

    // 4. Lint — catch remaining structural issues before deploying
    const lintErrors = lint.warnings.filter(w => w.severity === 'error');
    if (lintErrors.length > 0) {
      return {
        success: false,
        error: {
          code: 'LINT_ERRORS',
          message: `${lintErrors.length} lint error(s) — fix before deploying: ${lintErrors.map(e => e.message).join('; ')}`,
          recoverable: true,
          lint,
        },
      };
    }

    try {
      const token = await scope.resolveToken();
      const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };

      // 3. Create ruleset
      const createRes = await fetch(`${RULES_API}/projects/${scope.projectId}/rulesets`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ source: { files: [{ name: 'firestore.rules', content: source }] } }),
      });

      if (createRes.status === 403) {
        return {
          success: false,
          error: { code: 'PERMISSION_DENIED', message: 'Service account lacks permission to create Firestore rulesets', recoverable: false },
        };
      }

      if (!createRes.ok) {
        const body = await createRes.text().catch(() => '');
        return {
          success: false,
          error: { code: 'CREATE_RULESET_FAILED', message: `Failed to create ruleset: ${createRes.status} ${body}`, recoverable: createRes.status === 400 },
        };
      }

      const createData = await createRes.json() as { name: string };
      const rulesetName = createData.name;
      const rulesetId = rulesetName.split('/').pop()!;

      // 4. Update the cloud.firestore release to point at the new ruleset.
      // The body MUST include `release.name`. Without it the API responds
      // 200 OK but the active release is left pointing at the previous
      // ruleset — a silent failure where the tool reports success but
      // production rules never change. The release name in the URL path
      // is not enough; the body field is what the API actually reads.
      const releaseName = `projects/${scope.projectId}/releases/cloud.firestore`;
      const releaseRes = await fetch(`${RULES_API}/${releaseName}`, {
        method: 'PATCH',
        headers,
        body: JSON.stringify({ release: { name: releaseName, rulesetName } }),
      });

      if (releaseRes.status === 403) {
        return {
          success: false,
          error: { code: 'PERMISSION_DENIED', message: 'Service account lacks permission to create Firestore releases', recoverable: false },
        };
      }

      if (!releaseRes.ok) {
        const body = await releaseRes.text().catch(() => '');
        return {
          success: false,
          error: { code: 'CREATE_RELEASE_FAILED', message: `Failed to create release: ${releaseRes.status} ${body}`, recoverable: false },
        };
      }

      return { success: true, data: { rulesetId, findings, lint } };
    } catch (e) {
      return {
        success: false,
        error: { code: 'DEPLOY_FAILED', message: e instanceof Error ? e.message : String(e), recoverable: false },
      };
    }
  }
}

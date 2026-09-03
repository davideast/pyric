/**
 * Realtime Database rules source tooling for the bridge: the in-process
 * handlers behind `database_rules` lint, validate, and generate. Lint and
 * validate compile a rules JSON object with the engine the CLI commands use;
 * generate loads a constraints module from disk, so this factory is
 * Node-only and runs in the MCP process.
 */
import type { ToolHandler } from '@inbrowser/agent';
import { compileRtdbRules } from 'pyric/rules/internal/rtdb';
import { loadRtdbRulesDocument } from './load-rules-document.js';
import { collectRtdbRuleFindings } from './rule-findings.js';

interface RulesJsonArgs {
  rules: unknown;
}

interface GenerateArgs {
  configPath?: string;
  cwd?: string;
}

const RULES_FIELD = {
  type: 'object',
  description:
    'The rules document as a JSON object with a top-level `rules` key, the shape of database.rules.json.',
} as const;

function invalidRules(error: unknown) {
  return {
    ok: false,
    summary: `Invalid rules JSON: ${error instanceof Error ? error.message : String(error)}`,
    data: { code: 'INVALID_RULES_JSON' },
  };
}

/**
 * Bundles:
 *   - `rtdb_lint_rules`
 *   - `rtdb_validate_rules`
 *   - `rtdb_generate_rules`
 */
export function createRtdbRulesTools(): ToolHandler[] {
  return [
    {
      name: 'rtdb_lint_rules',
      description:
        'Lint a Realtime Database rules document: compile every `.read`, `.write`, and `.validate` expression and report the lint warnings, keyed by path and rule. Pure-local, no database is contacted.',
      parameters: {
        type: 'object',
        properties: { rules: RULES_FIELD },
        required: ['rules'],
      },
      async execute(rawArgs) {
        const { rules } = rawArgs as RulesJsonArgs;
        let compiled;
        try {
          compiled = compileRtdbRules(rules);
        } catch (error) {
          return invalidRules(error);
        }
        const warnings = collectRtdbRuleFindings(compiled, 'warnings');
        return {
          ok: true,
          summary:
            warnings.length === 0
              ? 'Lint clean'
              : `Lint found ${warnings.length} warning${warnings.length === 1 ? '' : 's'}`,
          data: { warnings },
        };
      },
    },
    {
      name: 'rtdb_validate_rules',
      description:
        'Validate a Realtime Database rules document: compile every `.read`, `.write`, and `.validate` expression and report the parse and validation errors, keyed by path and rule. Pure-local, no database is contacted.',
      parameters: {
        type: 'object',
        properties: { rules: RULES_FIELD },
        required: ['rules'],
      },
      async execute(rawArgs) {
        const { rules } = rawArgs as RulesJsonArgs;
        let compiled;
        try {
          compiled = compileRtdbRules(rules);
        } catch (error) {
          return invalidRules(error);
        }
        const errors = collectRtdbRuleFindings(compiled, 'errors');
        return {
          ok: errors.length === 0,
          summary:
            errors.length === 0
              ? 'Validation clean'
              : `Validation found ${errors.length} error${errors.length === 1 ? '' : 's'}`,
          data: { errors },
        };
      },
    },
    {
      name: 'rtdb_generate_rules',
      description:
        'Compile a local RTDB constraints module (a file that calls `defineRtdbRules` from pyric/rules) into database.rules.json data for inspection, tests, or committing.',
      parameters: {
        type: 'object',
        properties: {
          configPath: {
            type: 'string',
            description:
              "Path to the constraints module, relative to cwd. Defaults to 'database.rules.ts'.",
          },
          cwd: {
            type: 'string',
            description: 'Working directory used to resolve configPath. Defaults to process.cwd().',
          },
        },
      },
      async execute(rawArgs) {
        const { configPath, cwd } = rawArgs as GenerateArgs;
        const loaded = await loadRtdbRulesDocument(configPath ?? 'database.rules.ts', { cwd });
        if (!loaded.ok) return { ok: false, summary: loaded.message };

        return {
          ok: true,
          summary: 'Compiled RTDB constraints to database.rules.json',
          data: { rulesJson: loaded.document.toJSON() },
        };
      },
    },
  ];
}

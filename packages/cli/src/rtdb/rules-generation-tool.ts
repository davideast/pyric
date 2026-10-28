import { rtdbRulesSourceRejection } from 'pyric/rules/internal/rtdb';
import type { ToolHandler } from 'pyric/sandbox/internal';
import { loadRtdbRulesDocument } from './load-rules-document.js';

/** Local RTDB artifact generation for the CLI's agent registry. */
export function createRtdbRulesGenerationTools(): ToolHandler[] {
  return [
    {
      name: 'rtdb_generate_rules',
      description:
        'Compile a local RTDB constraints module into database.rules.json data for inspection, tests, or committing.',
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
      async execute(args) {
        const { configPath, cwd } = args as { configPath?: string; cwd?: string };
        const targetPath = configPath ?? 'database.rules.ts';
        const loaded = await loadRtdbRulesDocument(targetPath, { cwd });
        if (!loaded.ok) return { ok: false, summary: loaded.message };

        const rulesJson = loaded.document.toJSON();
        const rejection = rtdbRulesSourceRejection(rulesJson);
        if (rejection !== null) {
          return {
            ok: false,
            summary: `${targetPath} generates rules that would not deploy. ${rejection.message}`,
          };
        }

        return {
          ok: true,
          summary: 'Compiled RTDB constraints to database.rules.json',
          data: { rulesJson },
        };
      },
    },
  ];
}

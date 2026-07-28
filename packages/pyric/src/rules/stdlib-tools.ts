/**
 * Browser-safe agent-tool factory for the rules stdlib reference.
 *
 * Why a separate file: `createFirestoreRulesTools` lives in `./tools.ts`
 * alongside the Node-only resolver — so the whole factory ships from
 * `pyric/rules/internal/node`. The stdlib tools are pure data (no
 * fs, no network) and useful to browser consumers (the playground
 * imports them straight into its tool registry). Keeping the data +
 * tool factory together in this file lets the main `pyric/firestore-
 * rules` entry export them without dragging in `node:fs`.
 *
 * The Node-only `createFirestoreRulesTools` factory still bundles
 * these into its output via `...createFirestoreRulesStdlibTools()`,
 * so server-side hosts that pick up the whole rules-tool set get the
 * stdlib pair for free.
 */
import type { ToolHandler } from '@inbrowser/agent';
import { lintFirestoreRules } from './linter/linter.js';
import { resolveModulesBrowser } from './modules/resolver-browser.js';
import {
  STDLIB_MODULES,
  findModuleByKey,
  allModuleKeys,
  suggestKey,
} from './stdlib-modules.js';

export function createFirestoreRulesStdlibTools(): ToolHandler[] {
  return [
    {
      name: 'firestore_rules_stdlib_list',
      description:
        "List every Firestore Rules stdlib module as { key, kind, description }. Returns ~20 entries covering language namespaces (math, timestamp, duration, latlng, hashing), built-in type methods (string, list, map, bytes, path), the request/resource/builtins globals, and user-authored library modules (auth, validation, lobby, etc.) the project can import. Call this BEFORE writing rules — pick the relevant key(s) from the result, then call firestore_rules_stdlib_get for full signatures + examples. Cheap (~1.5KB) so calling once per session is the right default. Skipping this and inventing a function name fails rules compile.",
      parameters: {
        type: 'object',
        properties: {},
      },
      async execute() {
        return {
          ok: true,
          summary: `Listed ${STDLIB_MODULES.length} stdlib modules`,
          data: {
            authoring:
              "user-module entries are IMPORTED, never copied: start the rules file with rules_version = '2+modules'; add one `import { fn } from 'key';` line per module; call the functions in allow conditions. write_file inlines imports on save.",
            modules: STDLIB_MODULES.map((m) => ({
              key: m.key,
              kind: m.kind,
              description: m.description,
            })),
          },
        };
      },
    },
    {
      name: 'firestore_rules_stdlib_get',
      description:
        "Get the full detail for one Firestore Rules stdlib module by key. Returns the module's purpose + whenToUse + every callable inside it (signatures, descriptions, examples, common-mistake notes) + relatedKeys for navigation. Pass the `key` value from firestore_rules_stdlib_list — exact match, case-insensitive. On an unknown key the response includes the closest match suggestion and the full list of valid keys so the agent can self-correct without re-fetching the list.",
      parameters: {
        type: 'object',
        properties: {
          key: {
            type: 'string',
            description:
              'Module key from the list response — e.g. `math`, `list`, `auth`, `request`. Case-insensitive.',
          },
        },
        required: ['key'],
      },
      async execute(args) {
        const { key } = args as { key: string };
        const found = findModuleByKey(key);
        if (!found) {
          const suggestion = suggestKey(key);
          return {
            ok: false,
            summary:
              `No stdlib module named "${key}"` +
              (suggestion ? ` — did you mean "${suggestion}"?` : ''),
            data: {
              unknownKey: key,
              ...(suggestion ? { suggestion } : {}),
              validKeys: allModuleKeys(),
            },
          };
        }
        // User modules lead with the ready-to-paste import line — the
        // response shape nudges IMPORT-mode over copy-mode (epic #787):
        // bodies stay available in entries, but the first thing the
        // model reads is the line it should actually write.
        const importLine =
          found.kind === 'user-module'
            ? `import { ${found.entries
                .map((e) => e.signature.slice(0, e.signature.indexOf('(')))
                .join(', ')} } from '${found.key}';`
            : undefined;
        return {
          ok: true,
          summary:
            `Stdlib module: ${found.key} (${found.kind})` +
            (importLine ? ` — author with: ${importLine}` : ''),
          data: {
            ...(importLine
              ? {
                  importLine,
                  authoring:
                    "IMPORT these functions (rules_version = '2+modules'), do not copy their bodies — write_file inlines imports on save.",
                }
              : {}),
            module: found,
          },
        };
      },
    },
    {
      name: 'firestore_lint_rules',
      description:
        "Lint a Firestore Security Rules source BEFORE writing it. Catches parse errors with line/col, JS-style hallucinations (.filter / .toLowerCase / optional chaining / arrow functions), expression-budget violations, binary-chain depth (cap 98), let-binding count (cap 11), get() count, source size (256KB), and shared-gate / public-write smells. Pure-local — no auth, no network. Call this on any candidate source the moment you're about to `writeRules` — fixing a flagged issue here is cheaper than letting `runOnce` surface it as a denial after a deploy round-trip.",
      parameters: {
        type: 'object',
        properties: {
          source: {
            type: 'string',
            description: 'Firestore security rules source text to lint.',
          },
        },
        required: ['source'],
      },
      async execute(args) {
        const { source } = args as { source: string };
        const result = lintFirestoreRules(source);
        // A parse error means the source didn't parse — warnings carry
        // no signal (the linter short-circuits its budget checks). Surface
        // the parse failure as the headline result so the agent doesn't
        // see "Lint clean" next to a populated parseError object and
        // proceed assuming the rules compile.
        if (result.parseError) {
          const { line, column, message } = result.parseError;
          return {
            ok: false,
            summary: `Parse failed at line ${line}, col ${column} — fix syntax before writeRules`,
            data: result,
            message,
          };
        }
        const counts = {
          errors: result.warnings.filter((w) => w.severity === 'error').length,
          warnings: result.warnings.filter((w) => w.severity === 'warning').length,
        };
        return {
          ok: counts.errors === 0,
          summary:
            counts.errors === 0 && counts.warnings === 0
              ? 'Lint clean — safe to writeRules'
              : `Lint found ${counts.errors} error${counts.errors === 1 ? '' : 's'}, ${counts.warnings} warning${counts.warnings === 1 ? '' : 's'}`,
          data: result,
        };
      },
    },
    {
      name: 'firestore_resolve_modules',
      description:
        "Resolve `2+modules` imports in a Firestore Rules source. Inlines the imported functions from the stdlib modules (`auth`, `validation`, `lobby`, etc. — see `firestore_rules_stdlib_list`) and rewrites the version line from `2+modules` to plain `2`. Call this BEFORE `writeRules` when the source you authored uses `2+modules` syntax — the playground's `runOnce` only understands plain v2 source. Pure-local; the stdlib modules are bundled into the package, no filesystem access required.",
      parameters: {
        type: 'object',
        properties: {
          source: {
            type: 'string',
            description:
              'Firestore rules source whose version line is `2+modules` and that contains `import` statements at the top.',
          },
          modules: {
            type: 'object',
            additionalProperties: { type: 'string' },
            description:
              'Optional inline overrides — pass `{ moduleName: rulesSource }` to shadow a stdlib module with a project-local copy.',
          },
        },
        required: ['source'],
      },
      async execute(args) {
        const { source, modules } = args as {
          source: string;
          modules?: Record<string, string>;
        };
        const result = resolveModulesBrowser(
          source,
          modules ? { modules } : undefined,
        );
        if (!result.success) {
          return {
            ok: false,
            summary: `Resolve failed: ${result.error.message}`,
            data: result,
          };
        }
        return {
          ok: true,
          summary:
            result.data.modules.length > 0
              ? `Resolved ${result.data.modules.length} module${result.data.modules.length === 1 ? '' : 's'}: ${result.data.modules.join(', ')}`
              : 'No modules imported — source returned as-is (version rewritten to "2")',
          data: result.data,
        };
      },
    },
  ];
}

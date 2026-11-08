/**
 * Extract Realtime Database `.indexOn` requirements from TypeScript/JavaScript
 * source paths inside the project directory, preview the non-destructive merge
 * into `database.rules.json`, and check for missing `.indexOn` rules.
 */
import { existsSync, readFileSync } from 'node:fs';
import { z } from 'zod';
import { checkRtdbIndexes, mergeRtdbIndexes } from 'pyric/rules/internal/usage';
import { checkInstance, instanceArgument, INSTANCE_RENAMES } from '../../arguments/database.js';
import { realProjectPathWithin } from '../../arguments/project-real-path.js';
import { failFor } from '../../method-validation.js';
import type { MethodRecord } from '../../method-types.js';
import { errorMessage } from '../../../../rtdb/error-message.js';
import {
  extractRtdbIndexesFromPaths,
  resolveRtdbRulesTarget,
  type ExtractRtdbIndexesFromPathsOptions,
  type ResolveRtdbRulesTargetOptions,
} from '../../../../rtdb/extract-indexes.js';

const EMPTY_RULES_JSON = '{\n  "rules": {}\n}\n';

export default {
  tool: 'database',
  method: 'extractIndexes',
  runsIn: 'bridge',
  sdkOrigin: 'pyric',
  effect: 'read',
  signature: 'extractIndexes(paths?[], instance?, rulesPath?, check?)',
  description: 'Find .indexOn rules source paths need.',
  args: z.object({
    paths: z
      .array(z.string())
      .optional()
      .describe("Source files or directories inside the project directory to scan. Defaults to ['.']."),
    instance: instanceArgument,
    rulesPath: z
      .string()
      .optional()
      .describe('Rules JSON file inside the project directory to merge or check against.'),
    check: z
      .boolean()
      .optional()
      .describe('Include missing-index summary checks against the current rules file.'),
  }),
  operation: 'extract_database_indexes',
  renames: INSTANCE_RENAMES,
  example: { paths: ['.'] },
  validate: (args, { fail }) => checkInstance(args, fail),
  async handler(args, ctx) {
    const fail = failFor('database', 'extractIndexes');
    let rawPaths: string[] = ['.'];
    if (Array.isArray(args.paths) && args.paths.length > 0) {
      rawPaths = args.paths as string[];
    }

    const resolvedPaths: string[] = [];
    for (const entry of rawPaths) {
      const resolved = realProjectPathWithin(ctx.projectDir, entry, 'paths', fail);
      if (!('path' in resolved)) return resolved;
      if (!existsSync(resolved.path)) {
        return {
          ok: false,
          summary: `database.extractIndexes: path '${entry}' does not exist inside the project directory.`,
        };
      }
      resolvedPaths.push(resolved.path);
    }

    let explicitRulesFlag: string | undefined;
    if (typeof args.rulesPath === 'string') {
      explicitRulesFlag = args.rulesPath;
      const checkedRules = realProjectPathWithin(ctx.projectDir, explicitRulesFlag, 'rulesPath', fail);
      if (!('path' in checkedRules)) return checkedRules;
      if (!existsSync(checkedRules.path)) {
        return {
          ok: false,
          summary: `database.extractIndexes: rulesPath '${explicitRulesFlag}' does not exist inside the project directory.`,
        };
      }
    }

    const targetOpts: {
      cwd: string;
      rulesFlag?: string;
      instance?: string;
    } = { cwd: ctx.projectDir };
    if (explicitRulesFlag !== undefined) {
      targetOpts.rulesFlag = explicitRulesFlag;
    }
    if (typeof args.instance === 'string') {
      targetOpts.instance = args.instance;
    }

    let target: Awaited<ReturnType<typeof resolveRtdbRulesTarget>>;
    try {
      target = await resolveRtdbRulesTarget(targetOpts as ResolveRtdbRulesTargetOptions);
    } catch (err) {
      return { ok: false, summary: `database.extractIndexes: ${errorMessage(err)}` };
    }

    const rulesCheck = realProjectPathWithin(ctx.projectDir, target.rulesPath, 'rulesPath', fail);
    if (!('path' in rulesCheck)) return rulesCheck;

    const extractOpts: {
      projectDir: string;
      paths: readonly string[];
      instance?: string;
      includeDefaultInstance: boolean;
    } = {
      projectDir: ctx.projectDir,
      paths: resolvedPaths,
      includeDefaultInstance: target.includeDefaultInstance,
    };
    if (target.instance !== undefined) {
      extractOpts.instance = target.instance;
    }

    let passResult: ReturnType<typeof extractRtdbIndexesFromPaths>;
    try {
      passResult = extractRtdbIndexesFromPaths(extractOpts as ExtractRtdbIndexesFromPathsOptions);
    } catch (err) {
      return { ok: false, summary: `database.extractIndexes: ${errorMessage(err)}` };
    }

    let existingText = EMPTY_RULES_JSON;
    if (existsSync(rulesCheck.path)) {
      existingText = readFileSync(rulesCheck.path, 'utf8');
    }

    let merged: ReturnType<typeof mergeRtdbIndexes>;
    let diagnostics: ReturnType<typeof checkRtdbIndexes>;
    try {
      merged = mergeRtdbIndexes(existingText, passResult.requirements);
      diagnostics = checkRtdbIndexes(existingText, passResult.requirements);
    } catch (err) {
      return { ok: false, summary: `database.extractIndexes: ${errorMessage(err)}` };
    }

    let summary = `${passResult.requirements.length} .indexOn requirement(s) extracted (${merged.addedCount} missing from rules).`;
    if (args.check === true) {
      summary = `${diagnostics.length} missing .indexOn diagnostic(s) across ${passResult.requirements.length} requirement(s).`;
    }

    return {
      ok: true,
      summary,
      data: {
        requirements: passResult.requirements,
        mergedRules: merged.rules,
        mergedRulesText: merged.json,
        changed: merged.changed,
        addedCount: merged.addedCount,
        warnings: passResult.warnings,
        diagnostics,
      },
    };
  },
} satisfies MethodRecord;

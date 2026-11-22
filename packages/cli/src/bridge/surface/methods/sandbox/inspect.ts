/** Report what the sandbox holds across Firestore, Database, Storage, and Auth. */
import { z } from 'zod';
import { getClock } from 'pyric/sandbox';
import {
  inspect as inspectFirestore,
  listDeclaredFirestoreDatabases,
} from 'pyric/sandbox/firestore';
import {
  captureSandboxSnapshot,
  summarizeSandboxSnapshot,
} from 'pyric/sandbox/internal';
import {
  assertDeclaredFirestoreDatabase,
  checkFirestoreDatabase,
  databaseArgument,
  firestoreDatabaseSelector,
  onFirestoreDatabase,
} from '../../firestore-database.js';
import { callSandboxTool } from '../../sandbox-context.js';
import type { MethodRecord } from '../../method-types.js';

export default {
  tool: 'sandbox',
  method: 'inspect',
  runsIn: 'sandbox',
  sdkOrigin: 'pyric',
  effect: 'read',
  signature: 'inspect(includeData?, recentEventLimit?, database?)',
  description: 'Read state.',
  args: z.object({
    includeData: z.boolean().optional(),
    recentEventLimit: z.number().int().positive().optional(),
    database: databaseArgument,
  }),
  operation: 'inspect_sandbox',
  example: {},
  validate: (args, { fail }) => checkFirestoreDatabase(args, fail),
  async handler(args, ctx) {
    const selector = firestoreDatabaseSelector(args.database);
    let baseSummary: string;
    let base: Record<string, unknown> = {};
    if (selector === undefined) {
      const toolArgs: Record<string, unknown> = {};
      if (typeof args.recentEventLimit === 'number') {
        toolArgs.recentEventLimit = args.recentEventLimit;
      }
      const result = await callSandboxTool(ctx, 'sandbox_inspect', toolArgs);
      if (!result.ok) return result;
      baseSummary = result.summary;
      if (result.data !== null && typeof result.data === 'object') {
        base = result.data as Record<string, unknown>;
      }
    } else {
      assertDeclaredFirestoreDatabase(ctx, selector);
      let recentLimit: number | undefined;
      if (typeof args.recentEventLimit === 'number') {
        recentLimit = args.recentEventLimit;
      }
      const report = inspectFirestore(ctx.sandbox, {
        recentEventLimit: recentLimit,
        databaseId: selector,
      });
      base = report as unknown as Record<string, unknown>;
      let rulesPart = `${report.rules.sizeBytes}B, ${report.rules.lint.errors} errors / ${report.rules.lint.warnings} warnings`;
      if (report.rules.isEmpty) {
        rulesPart = 'EMPTY (setRules has not been called)';
      }
      const dot = '\u00b7';
      baseSummary = onFirestoreDatabase(
        `rules: ${rulesPart}`
          + ` ${dot} docs: ${report.documents.totalCount} across ${Object.keys(report.documents.byCollection).length} collections`
          + ` ${dot} events: ${report.events.totalCount} total, ${report.events.recentDenials.length} recent denials`,
        selector,
      );
    }

    const snapshot = await captureSandboxSnapshot(ctx.sandbox, {
      excludePasswords: true,
    });
    const services = summarizeSandboxSnapshot(snapshot, {
      includeData: args.includeData === true,
    });
    const clock = getClock(ctx.sandbox);
    const report: { mode: string; now: number; offsetMs?: number } = {
      mode: clock.mode,
      now: clock.now(),
    };
    if (clock.mode === 'offset') {
      report.offsetMs = clock.capture().offsetMs;
    }
    const declared = listDeclaredFirestoreDatabases(ctx.sandbox);
    const data: Record<string, unknown> = {
      ...base,
      firestore: services.firestore,
      database: services.database,
      storage: services.storage,
      auth: services.auth,
      clock: report,
    };
    if (declared.length > 0) {
      data.firestoreDeclared = declared;
    }
    const summary =
      `${baseSummary}`
      + ` · rtdb: ${services.database.nodeCount} nodes`
      + ` · storage: ${services.storage.totalObjects} objects`
      + ` · auth: ${services.auth.totalUsers} users`
      + ` · clock: ${clock.mode} at ${clock.date().toISOString()}`;
    return {
      ok: true,
      summary,
      data,
    };
  },
} satisfies MethodRecord;

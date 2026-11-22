/**
 * Run the cases a capture derives through the local engine.
 *
 * These are the same cases `pyric verify cases` writes out and the same cases
 * `testRulesHosted` sends to Firebase, decided here by the sandbox's own
 * simulator. Every case is reported, agreed and diverged alike, so a caller
 * comparing the local engine with the hosted one is comparing the same list.
 */
import { z } from 'zod';

import { CAPTURE_RELATIVE_PATH } from '../../../../serve/capture-store.js';

import {
  candidateRules,
  caseService,
  readFixtureFile,
} from '../../arguments/assurance.js';
import { runDerivedCases } from '../../assurance-cases.js';
import { operationFailure } from '../../context.js';
import {
  assertDeclaredFirestoreDatabase,
  checkFirestoreDatabase,
  databaseArgument,
  firestoreDatabaseSelector,
  onFirestoreDatabase,
} from '../../firestore-database.js';
import { failFor } from '../../method-validation.js';
import { activeFirestoreRules } from '../../rules-simulation.js';
import type { MethodRecord } from '../../method-types.js';
import type { OperationResult } from '../../types.js';

export default {
  tool: 'assurance',
  method: 'verifyCases',
  runsIn: 'bridge',
  sdkOrigin: 'pyric',
  effect: 'read',
  signature: 'verifyCases(fixture?, candidateRules?, database?, service?: firestore)',
  description: 'Check capture.',
  args: z.object({
    fixture: z
      .string()
      .optional()
      .describe(
        `The capture the cases are derived from, relative to the project directory. Defaults to ${CAPTURE_RELATIVE_PATH}.`,
      ),
    candidateRules,
    database: databaseArgument,
    service: caseService,
  }),
  validate(args, { fail }) {
    return checkFirestoreDatabase(args, fail);
  },
  operation: 'verify_assurance_cases',
  renames: { sessionPath: 'fixture', session: 'fixture', rules: 'candidateRules' },
  example: { fixture: CAPTURE_RELATIVE_PATH },
  async handler(args, ctx): Promise<OperationResult> {
    const named = typeof args.fixture === 'string' ? args.fixture : CAPTURE_RELATIVE_PATH;
    const read = readFixtureFile(
      ctx.projectDir,
      named,
      'fixture',
      failFor('assurance', 'verifyCases'),
    );
    if ('refusal' in read) return read.refusal;

    const selector = firestoreDatabaseSelector(args.database);
    let rules: string;
    if (typeof args.candidateRules === 'string') {
      rules = args.candidateRules;
    } else {
      assertDeclaredFirestoreDatabase(ctx, selector);
      rules = activeFirestoreRules(ctx, selector);
    }
    if (rules.length === 0) {
      return operationFailure(
        'No candidate rules were supplied and the sandbox is running none, so there is nothing to decide the cases against.',
      );
    }

    const run = runDerivedCases(read.fixture, rules, selector);
    if ('error' in run) return operationFailure(run.error);
    if (run.cases.length === 0) {
      return operationFailure(
        `'${named}' holds no Firestore request the derivation could turn into a case.`,
        { fixture: named, unsupportedEvents: run.unsupportedEvents },
      );
    }

    const failed = run.cases.filter((entry) => !entry.agrees);
    let baseSummary = `${failed.length} of ${run.cases.length} case(s) from '${named}' changed verdict, starting with ${failed[0]?.method} ${failed[0]?.path}`;
    if (failed.length === 0) {
      baseSummary = `All ${run.cases.length} case(s) from '${named}' reached the verdict the capture holds`;
    }
    const summary = `${onFirestoreDatabase(baseSummary, selector)}.`;
    const data: Record<string, unknown> = {
      fixture: named,
      service: 'firestore',
      agreed: run.agreed,
      diverged: run.diverged,
      cases: run.cases,
      unsupportedEvents: run.unsupportedEvents,
    };
    if (selector !== undefined) data.database = selector;
    return {
      ok: true,
      summary,
      data,
    };
  },
} satisfies MethodRecord;

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
import { failFor } from '../../method-validation.js';
import { activeFirestoreRules } from '../../rules-simulation.js';
import type { MethodRecord } from '../../method-types.js';
import type { OperationResult } from '../../types.js';

export default {
  tool: 'assurance',
  method: 'verifyCases',
  sdkOrigin: 'pyric',
  effect: 'read',
  signature: 'verifyCases(fixture?, candidateRules?, service?: firestore)',
  description:
    "Decide a capture's cases locally.",
  args: z.object({
    fixture: z
      .string()
      .optional()
      .describe(
        `The capture the cases are derived from, relative to the project directory. Defaults to ${CAPTURE_RELATIVE_PATH}.`,
      ),
    candidateRules,
    service: caseService,
  }),
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

    const rules =
      typeof args.candidateRules === 'string' ? args.candidateRules : activeFirestoreRules(ctx);
    if (rules.length === 0) {
      return operationFailure(
        'No candidate rules were supplied and the sandbox is running none, so there is nothing to decide the cases against.',
      );
    }

    const run = runDerivedCases(read.fixture, rules);
    if ('error' in run) return operationFailure(run.error);
    if (run.cases.length === 0) {
      return operationFailure(
        `'${named}' holds no Firestore request the derivation could turn into a case.`,
        { fixture: named, unsupportedEvents: run.unsupportedEvents },
      );
    }

    const failed = run.cases.filter((entry) => !entry.agrees);
    const summary =
      failed.length === 0
        ? `All ${run.cases.length} case(s) from '${named}' reached the verdict the capture holds.`
        : `${failed.length} of ${run.cases.length} case(s) from '${named}' changed verdict, starting with ${failed[0]!.method} ${failed[0]!.path}.`;
    // The cases were decided, which is what the call is for. A case that
    // changed verdict is the answer, not a failure of the call.
    return {
      ok: true,
      summary,
      data: {
        fixture: named,
        service: 'firestore',
        agreed: run.agreed,
        diverged: run.diverged,
        cases: run.cases,
        unsupportedEvents: run.unsupportedEvents,
      },
    };
  },
} satisfies MethodRecord;

/**
 * Replay a recorded session against candidate rules and report what broke.
 *
 * Two engines answer, because a rules change breaks two different things. The
 * replay engine re-issues every recorded write onto a fresh sandbox under the
 * candidate rules and reports where the resulting state differs from the state
 * the recording ended with. The local simulator decides each recorded request
 * again and reports where its verdict differs from the verdict the recording
 * holds. The second is what a caller asking what breaks means, and the first is
 * what it costs.
 */
import { z } from 'zod';

import { CAPTURE_RELATIVE_PATH } from '../../../../serve/capture-store.js';

import { verifyFixture, type VerifyDivergence } from '../../../../verify/index.js';
import {
  candidateRules,
  readFixtureFile,
  replayService,
  verifiableService,
} from '../../arguments/assurance.js';
import { runDerivedCases, type CaseVerdict } from '../../assurance-cases.js';
import { operationFailure } from '../../context.js';
import { failFor } from '../../method-validation.js';
import { activeFirestoreRules } from '../../rules-simulation.js';
import type { MethodRecord } from '../../method-types.js';
import type { OperationResult } from '../../types.js';

/** One verdict pair the candidate rules changed, in the shape the result reports. */
interface VerdictDivergence {
  kind: 'verdict-divergence';
  path: string;
  method: string;
  recorded: CaseVerdict['recorded'];
  candidate: CaseVerdict['candidate'];
  reason: string;
}

/** The verdict divergences among a set of decided cases. */
function verdictDivergences(cases: readonly CaseVerdict[]): VerdictDivergence[] {
  return cases
    .filter((entry) => !entry.agrees)
    .map((entry) => ({
      kind: 'verdict-divergence' as const,
      path: entry.path,
      method: entry.method,
      recorded: entry.recorded,
      candidate: entry.candidate,
      reason: `the recording holds ${entry.recorded} and the candidate reaches ${entry.candidate}`,
    }));
}

/** The state divergences a replay found, minus the ones it classifies as expected. */
function stateDivergences(found: readonly VerifyDivergence[]): VerifyDivergence[] {
  return found.filter((divergence) => divergence.kind !== 'expected-drift');
}

export default {
  tool: 'assurance',
  method: 'replaySession',
  sdkOrigin: 'pyric',
  effect: 'read',
  signature: 'replaySession(sessionPath?, candidateRules?, service?: firestore|database)',
  description:
    'Replay a capture under candidate rules.',
  args: z.object({
    sessionPath: z
      .string()
      .optional()
      .describe(
        `The recorded session to replay, relative to the project directory. Defaults to ${CAPTURE_RELATIVE_PATH}.`,
      ),
    candidateRules,
    service: replayService,
  }),
  operation: 'replay_assurance_session',
  renames: { session: 'sessionPath', fixture: 'sessionPath', rules: 'candidateRules' },
  example: { sessionPath: CAPTURE_RELATIVE_PATH },
  async handler(args, ctx): Promise<OperationResult> {
    const named = typeof args.sessionPath === 'string' ? args.sessionPath : CAPTURE_RELATIVE_PATH;
    const read = readFixtureFile(
      ctx.projectDir,
      named,
      'sessionPath',
      failFor('assurance', 'replaySession'),
    );
    if ('refusal' in read) return read.refusal;

    const service = verifiableService(args.service as string | undefined);
    const rules =
      typeof args.candidateRules === 'string' ? args.candidateRules : activeFirestoreRules(ctx);
    if (service === 'firestore' && rules.length === 0) {
      return operationFailure(
        'No candidate rules were supplied and the sandbox is running none, so there is nothing to replay against.',
      );
    }

    let replayed;
    try {
      replayed = await verifyFixture(read.fixture, {
        rules: service === 'firestore' ? { firestore: rules } : { rtdb: JSON.parse(rules) },
        services: [service],
        engines: ['sandbox'],
      });
    } catch (error) {
      return operationFailure(error instanceof Error ? error.message : String(error));
    }

    const state = stateDivergences(replayed.services[service]?.divergences ?? []);
    const decided = service === 'firestore' ? runDerivedCases(read.fixture, rules) : { cases: [] };
    const verdicts = 'cases' in decided ? verdictDivergences(decided.cases) : [];
    const divergences = [...verdicts, ...state];
    const summary =
      divergences.length === 0
        ? `Replaying '${named}' under the candidate rules changed no recorded verdict.`
        : `Replaying '${named}' under the candidate rules changed ${verdicts.length} verdict(s) and left ${state.length} state divergence(s).`;
    // The read succeeded whatever it found, so a replay that reports what
    // breaks is not an error. What broke is in the data, and a caller that
    // asks what breaks is asking for exactly that.
    return {
      ok: true,
      summary,
      data: {
        sessionPath: named,
        service,
        checkedEvents: replayed.services[service]?.checkedEvents ?? 0,
        divergences,
      },
    };
  },
} satisfies MethodRecord;

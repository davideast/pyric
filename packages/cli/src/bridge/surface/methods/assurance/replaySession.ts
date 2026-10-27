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
import { getActiveRules } from 'pyric/sandbox/database';
import { z } from 'zod';

import { parseRtdbRulesText } from '../../../../rtdb/rules-json.js';
import { CAPTURE_RELATIVE_PATH } from '../../../../serve/capture-store.js';

import { verifyFixture, type VerifyDivergence, type VerifyRulesInput } from '../../../../verify/index.js';
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

/**
 * A replay divergence that is a verdict the candidate rules changed: the
 * database replay re-decides each recorded request and reports `now-denied`
 * or `now-allowed`. Firestore's derived cases report those same requests as
 * verdict divergences, so only the database replay's are counted here.
 */
function isReplayVerdict(service: string, divergence: VerifyDivergence): boolean {
  return service === 'rtdb' && (divergence.kind === 'now-denied' || divergence.kind === 'now-allowed');
}

/** The state divergences a replay found, minus the ones it classifies as expected and the verdicts it re-decided. */
function stateDivergences(service: string, found: readonly VerifyDivergence[]): VerifyDivergence[] {
  return found.filter((divergence) => divergence.kind !== 'expected-drift' && !isReplayVerdict(service, divergence));
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
    let firestoreRules = '';
    let rulesInput: VerifyRulesInput;
    if (service === 'firestore') {
      firestoreRules =
        typeof args.candidateRules === 'string' ? args.candidateRules : activeFirestoreRules(ctx);
      if (firestoreRules.length === 0) {
        return operationFailure(
          'No candidate rules were supplied and the sandbox is running none, so there is nothing to replay against.',
        );
      }
      rulesInput = { firestore: firestoreRules };
    } else {
      let rtdbRules: ReturnType<typeof getActiveRules> = null;
      if (typeof args.candidateRules === 'string') {
        try {
          rtdbRules = parseRtdbRulesText(args.candidateRules, (reason) => reason);
        } catch (error) {
          return operationFailure(error instanceof Error ? error.message : String(error));
        }
      } else {
        rtdbRules = getActiveRules(ctx.sandbox);
      }
      if (rtdbRules === null || rtdbRules === undefined) {
        return operationFailure(
          'No candidate rules were supplied and the sandbox is running none, so there is nothing to replay against.',
        );
      }
      rulesInput = { rtdb: rtdbRules };
    }

    let replayed;
    try {
      replayed = await verifyFixture(read.fixture, {
        rules: rulesInput,
        services: [service],
        engines: ['sandbox'],
      });
    } catch (error) {
      return operationFailure(error instanceof Error ? error.message : String(error));
    }

    const replayDivergences = replayed.services[service]?.divergences ?? [];
    const state = stateDivergences(service, replayDivergences);
    const redecided = replayDivergences.filter((divergence) => isReplayVerdict(service, divergence));
    const decided =
      service === 'firestore' ? runDerivedCases(read.fixture, firestoreRules) : { cases: [] };
    if ('error' in decided) return operationFailure(decided.error);
    const verdicts = verdictDivergences(decided.cases);
    const verdictCount = verdicts.length + redecided.length;
    const divergences = [...verdicts, ...redecided, ...state];
    const skippedInstances = replayed.services[service]?.skippedInstances ?? [];
    const found =
      divergences.length === 0
        ? `Replaying '${named}' under the candidate rules changed no recorded verdict.`
        : `Replaying '${named}' under the candidate rules changed ${verdictCount} verdict(s) and left ${state.length} state divergence(s).`;
    // The candidate rules are the default instance's; a named instance the
    // session used is named rather than checked against them.
    const skipped =
      skippedInstances.length === 0
        ? ''
        : ` Not checked: the session also used database instance(s) ${skippedInstances.join(', ')}; run \`pyric verify --rules rtdb:<instance>=<path>\` to check them.`;
    const summary = found + skipped;
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
        ...(skippedInstances.length > 0 ? { skippedInstances } : {}),
      },
    };
  },
} satisfies MethodRecord;

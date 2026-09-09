/**
 * The `assurance` tool's argument vocabulary: the services its engines
 * evaluate, the recorded session and fixture files its methods read, and the
 * campaign arguments its run-loop methods share.
 *
 * Two services are named here and they are named the way the rest of the
 * surface names them. The replay engine calls the Realtime Database `rtdb`
 * and the surface calls it `database`, so the enum a caller reads spells
 * `database` and the translation to the engine's word happens once, here,
 * rather than in each record that dispatches on it.
 */
import { readFileSync } from 'node:fs';
import { z } from 'zod';

import { parseVerifyFixture, type PyricVerifyFixture, type VerifiableService } from '../../../verify/index.js';
import type { Fail, InvalidArguments } from '../method-types.js';
import { projectPathWithin } from './sandbox.js';
import { CAPTURE_RELATIVE_PATH } from '../../../serve/capture-store.js';

/** The services the replay engine evaluates, under the surface's own names. */
export const REPLAY_SERVICES = ['firestore', 'database'] as const;

/** The services the derived-case engines evaluate. Case derivation is Firestore only. */
export const CASE_SERVICES = ['firestore'] as const;

/** The service a replay names, defaulting to Firestore, which every capture carries. */
export const replayService = z
  .enum(REPLAY_SERVICES)
  .optional()
  .describe('The service whose rules the replay evaluates: firestore or database.');

/** The service a derived-case run names. Case derivation reads Firestore requests only. */
export const caseService = z
  .enum(CASE_SERVICES)
  .optional()
  .describe('The service whose cases are run. Case derivation reads firestore requests only.');

/** The engine's own word for one of the surface's service names. */
export function verifiableService(named: string | undefined): VerifiableService {
  if (named === 'database') return 'rtdb';
  return 'firestore';
}

/** The campaign one run-loop call acts on. Campaigns live for the life of the sandbox. */
export const campaignId = z
  .string()
  .min(1)
  .describe('The campaign this call acts on, as attach or start reported it.');

/** The probe one call inspects or minimizes, as run reported it. */
export const probeId = z
  .string()
  .min(1)
  .describe('The probe this call acts on, as propose or run reported it.');

/** One authored record a run-loop method carries through to the campaign. */
export const authoredRecord = z.record(z.unknown());

/** The candidate rules a replay or a case run evaluates in place of the recorded ones. */
export const candidateRules = z
  .string()
  .optional()
  .describe('The rules source the run evaluates. Absent, the sandbox rules loaded now are used.');

/** What one file read produced: the fixture, or the refusal that says why not. */
export type FixtureRead = { fixture: PyricVerifyFixture } | { refusal: InvalidArguments };

/**
 * Read one recorded session or fixture from a path inside the project
 * directory. The path rule is the shared one, so the same absolute path a
 * `sandbox` method accepts is the one an `assurance` method accepts, and a
 * file that is not a capture is refused by name rather than by a parse error
 * from three frames down.
 */
export function readFixtureFile(
  projectDir: string,
  named: string,
  field: string,
  fail: Fail,
): FixtureRead {
  const resolved = projectPathWithin(projectDir, named, field, fail);
  if (!('path' in resolved)) return { refusal: resolved };
  let raw: string;
  try {
    raw = readFileSync(resolved.path, 'utf8');
  } catch {
    return {
      refusal: fail(
        `'${field}' is '${named}', and no file was read there.`,
        `Pass '${field}' as a capture inside the project directory, such as '${CAPTURE_RELATIVE_PATH}'.`,
        field,
      ),
    };
  }
  try {
    return { fixture: parseVerifyFixture(JSON.parse(raw)) };
  } catch (error) {
    return {
      refusal: fail(
        `'${named}' is not a recorded session: ${error instanceof Error ? error.message : String(error)}`,
        `Pass '${field}' as a capture the sandbox wrote, such as '${CAPTURE_RELATIVE_PATH}'.`,
        field,
      ),
    };
  }
}

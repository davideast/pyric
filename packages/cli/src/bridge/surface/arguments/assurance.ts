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

import {
  ACQUISITION_KINDS,
  INVARIANT_CONFIDENCES,
  INVARIANT_DECISIONS,
  INVARIANT_SERVICES,
  INVARIANT_SOURCES,
  MUTATION_DIMENSIONS,
  OBSERVATION_RESULTS,
  OBSERVATION_SOURCES,
  OPERATION_METHODS,
  OPERATION_SERVICES,
  REQUIRES_KINDS,
} from '../../../assurance/validation.js';
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

/**
 * The request methods any service evaluates, as one enum.
 *
 * A method is only meaningful for the service that evaluates it, and the
 * campaign validator holds each service to its own list. The schema spells the
 * union so every value is visible before the first call, and the validator
 * narrows it to the named service and says which values that service takes.
 */
export const OPERATION_METHOD_VALUES: readonly string[] = [
  ...new Set(Object.values(OPERATION_METHODS).flat()),
];

/** One operation against one service, as every authored record spells it. */
export const firebaseOperation = z
  .object({
    service: z.enum(OPERATION_SERVICES).describe('The service the operation runs against.'),
    method: z
      .enum(OPERATION_METHOD_VALUES as [string, ...string[]])
      .describe('The request method, from the set the named service evaluates.'),
    path: z.string().min(1).describe('The document, node, or object path.'),
    data: z.record(z.unknown()).optional().describe('The value written, for a write.'),
    query: z.record(z.unknown()).optional().describe('The query, for a list.'),
    dataBase64: z.string().optional().describe('The object body, for a storage upload.'),
    contentType: z.string().optional().describe('The object content type, for a storage upload.'),
    customMetadata: z
      .record(z.string())
      .optional()
      .describe('The object custom metadata, for a storage upload.'),
  })
  .describe('One operation: the service, the request method, the path, and the value.');

/** How an actor gets its identity, and what that acquisition needs. */
export const actorAcquisition = z
  .object({
    kind: z.enum(ACQUISITION_KINDS).describe('How the identity is obtained.'),
    email: z.string().optional().describe('The sign-in email, for a password acquisition.'),
    password: z.string().optional().describe('The sign-in password, for a password acquisition.'),
    uid: z
      .string()
      .optional()
      .describe('The user id, for a fixture-user or synthetic acquisition.'),
    token: z.record(z.unknown()).optional().describe('The token claims, for a synthetic actor.'),
  })
  .describe('How this identity is acquired.');

/** One identity an attacker can reach the target as. */
export const assuranceActor = z.object({
  id: z.string().min(1).describe('The name later records use for this actor.'),
  acquisition: actorAcquisition,
});

/** One operation observed succeeding, which a probe is proposed from. */
export const assuranceObservation = z.object({
  id: z.string().min(1).describe('The name a proposal uses for this observation.'),
  actorId: z.string().min(1).describe('The actor the operation ran as.'),
  result: z
    .enum(OBSERVATION_RESULTS)
    .describe('An observation records a known-good operation, so the result is ALLOW.'),
  source: z.enum(OBSERVATION_SOURCES).describe('Where the observation came from.'),
  operation: firebaseOperation,
});

/** The one change a probe makes to its control operation. */
export const probeMutation = z.object({
  dimension: z.enum(MUTATION_DIMENSIONS).describe('The one thing this probe changes.'),
  description: z.string().min(1).describe('What the change is, in one sentence.'),
  operation: firebaseOperation,
});

/** One authored probe: a control operation, and the single change made to it. */
export const assuranceProbe = z.object({
  id: z.string().min(1).describe('The name a run and an inspect use for this probe.'),
  actorId: z.string().min(1).describe('The actor both operations run as.'),
  invariantId: z.string().min(1).describe('The invariant this probe is judged against.'),
  control: firebaseOperation,
  mutation: probeMutation,
  requires: z
    .array(
      z.object({
        kind: z.enum(REQUIRES_KINDS).describe('What the probe depends on.'),
        id: z.string().min(1).describe('The construct or registry row it names.'),
      }),
    )
    .optional()
    .describe('What this probe depends on, for a report that traces its evidence.'),
});

/** One authorization boundary a probe is judged against. */
export const securityInvariant = z.object({
  id: z.string().min(1).describe('The name a probe uses for this invariant.'),
  statement: z.string().min(1).describe('What is supposed to happen, in one sentence.'),
  service: z.enum(INVARIANT_SERVICES).describe('The service this boundary is stated about.'),
  expected: z.enum(INVARIANT_DECISIONS).describe('The decision the boundary requires.'),
  source: z.enum(INVARIANT_SOURCES).describe('Where the boundary was stated.'),
  confidence: z.enum(INVARIANT_CONFIDENCES).describe('How much weight the boundary carries.'),
});

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

/**
 * firebase-admin createToken option captures: how option values are validated
 * (synchronous throw or rejection, with the message), the ttl a limitedUse
 * token gets, whether a chosen jti is carried, how fractional ttlMillis is
 * rounded, and what verifyToken consume answers for two tokens minted with
 * the same jti. The behavior blocks come from admin-option-behavior.ts, which
 * the pyric-admin replay runs too; this file writes them as observations.
 */
import type { AppCheck } from 'firebase-admin/app-check';
import { createTokenBehavior, mintSameJtiPair, sameJtiConsumeBehavior, type OptionTarget } from './admin-option-behavior.ts';
import { writeObservation, type ObservationContext } from './observation-writer.ts';
import { redactText, type Secrets } from './redact.ts';

export const CREATE_TOKEN_OBSERVATION = 'app-check-admin-options-create-token';
export const SAME_JTI_OBSERVATION = 'app-check-admin-options-same-jti-consume';

/** What the runner captures, printed by the entry script when it runs inert. */
export const ADMIN_OPTION_PLAN: { name: string; captures: string }[] = [
  {
    name: CREATE_TOKEN_OBSERVATION,
    captures:
      'createToken option validation (sync throw or rejection, code, message) for 11 malformed inputs; limitedUse ttl with and without a chosen jti; whether the jti is carried; fractional ttlMillis rounding.',
  },
  {
    name: SAME_JTI_OBSERVATION,
    captures:
      'two limitedUse tokens minted with the same jti (identical or not), then verifyToken consume on the first, the second, and the first again, with the result key order.',
  },
];

const CREATE_TOKEN_DESCRIPTION =
  'firebase-admin createToken options. validation: for each malformed input, whether createToken throws synchronously or returns a rejected promise, with the error code and message. limitedUse: the ttl a limitedUse token gets with no jti and with a chosen jti, and whether the chosen jti is the token jti claim. fractionalTtl: the ttlMillis returned and exp minus iat for fractional ttlMillis values. Token values are never stored.';
const SAME_JTI_DESCRIPTION =
  'Two firebase-admin createToken calls with limitedUse true and the same chosen jti: whether they return the identical token, then verifyToken with consume true on the first token, the second token, and the first token again, recording alreadyConsumed and the result key order. Token values are never stored.';

export interface AdminOptionInput {
  context: ObservationContext;
  appCheck: AppCheck;
  appId: string;
  runJti: string;
}

async function probe(name: string, failures: string[], secrets: Secrets, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
  } catch (error) {
    failures.push(name);
    console.error(`failed ${name}: ${redactText(String(error), secrets)}`);
  }
}

export async function runAdminOptionProbes(input: AdminOptionInput, failures: string[]): Promise<void> {
  const { context } = input;
  const target: OptionTarget = { appCheck: input.appCheck, appId: input.appId, runJti: input.runJti, secrets: context.secrets };
  const pair = await mintSameJtiPair(target);
  await probe(CREATE_TOKEN_OBSERVATION, failures, context.secrets, async () => {
    writeObservation(context, CREATE_TOKEN_OBSERVATION, CREATE_TOKEN_DESCRIPTION, await createTokenBehavior(target, pair), 'admin');
  });
  await probe(SAME_JTI_OBSERVATION, failures, context.secrets, async () => {
    writeObservation(context, SAME_JTI_OBSERVATION, SAME_JTI_DESCRIPTION, await sameJtiConsumeBehavior(target, pair), 'admin');
  });
}

/**
 * What the five sign-in methods share: the tenant a sign-in resolves under,
 * the report a sign-in returns, and the refusal a bad credential returns.
 *
 * A sign-in moves the app session and leaves the agent identity alone, so all
 * five report the same two things and differ only in the credential they take.
 * Writing that once is what keeps the distinction from drifting method by
 * method.
 *
 * The tenant needs saying. The sandbox pins a signing-in identity to the
 * handle's own `tenantId`, which is how Identity Platform resolves a
 * credential against one tenant's pool. A headless caller has no page to set
 * that handle, so a sign-in would resolve every identity into the project pool
 * and take the tenant off the record it just read. The handle is therefore
 * pinned to the tenant the stored record already belongs to, before the
 * credential is presented.
 */
import { getAuth, sandbox as authSandbox } from 'pyric/auth';
import type { LocalSandbox } from 'pyric/sandbox';

import { describeAppSession, readAppSession } from './app-session.js';
import { operationFailure } from './context.js';
import { describeAgentIdentity } from './held-identity.js';
import type { OperationResult, SurfaceContext } from './types.js';

/** The sentence every sign-in refusal ends with, naming the two ways to fix it. */
export const MISSING_ACCOUNT_FIX =
  'Create the account with auth.createUser, or seed it with sandbox.seed, then sign in again.';

/** Which stored record a sign-in is about, by whichever name the call carries. */
export interface SignInSubject {
  uid?: string | undefined;
  email?: string | undefined;
}

/** The record a subject names, or undefined when the pool holds none. */
function storedRecord(sandbox: LocalSandbox, subject: SignInSubject) {
  const records = authSandbox.listUsers(getAuth(sandbox));
  if (subject.uid !== undefined) return records.find((entry) => entry.uid === subject.uid);
  if (subject.email === undefined) return undefined;
  const wanted = subject.email.toLowerCase();
  return records.find((entry) => entry.email?.toLowerCase() === wanted);
}

/**
 * Pin the handle to the tenant the identity being signed in belongs to, so the
 * credential resolves in that tenant's pool and the record keeps its tenant.
 * An identity the pool does not hold resolves at the project level.
 */
export function scopeToStoredTenant(sandbox: LocalSandbox, subject: SignInSubject): void {
  getAuth(sandbox).tenantId = storedRecord(sandbox, subject)?.tenantId ?? null;
}

/**
 * Report what a sign-in or a sign-out did: the app session it moved, and the
 * agent identity it left alone.
 */
export function reportAppSession(ctx: SurfaceContext): OperationResult {
  const appSession = readAppSession(ctx.sandbox);
  const agent = ctx.identity.describe();
  return {
    ok: true,
    summary:
      `The app session is ${describeAppSession(appSession)}. ` +
      `The next call still runs as ${describeAgentIdentity(agent)}. ` +
      'Call useAppSession to run later calls as the app session.',
    data: { appSession, agent },
  };
}

/** The Firebase error code a thrown sign-in carries. */
function codeOf(error: unknown): string {
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' ? code : 'auth/internal-error';
}

/**
 * Refuse one sign-in in the SDK's own words: the code the sandbox raised, the
 * message it raised with it, and the sentence that says how to have the
 * account exist.
 */
export function signInFailure(method: string, error: unknown): OperationResult {
  const code = codeOf(error);
  const message = error instanceof Error ? error.message : String(error);
  return operationFailure(`auth.${method}: ${message} (${code}). ${MISSING_ACCOUNT_FIX}`, {
    code,
    tool: 'auth',
    method,
    fix: MISSING_ACCOUNT_FIX,
  });
}

/** Read one base64url segment as JSON, or null when it is neither. */
function jsonFrom(segment: string): Record<string, unknown> | null {
  const candidates = [segment, base64UrlText(segment)];
  for (const candidate of candidates) {
    if (candidate === null) continue;
    try {
      const parsed: unknown = JSON.parse(candidate);
      if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      continue;
    }
  }
  return null;
}

/** The text a base64url segment decodes to, or null when it is not base64url. */
function base64UrlText(segment: string): string | null {
  try {
    const padded = segment.replace(/-/g, '+').replace(/_/g, '/');
    return atob(padded.padEnd(Math.ceil(padded.length / 4) * 4, '='));
  } catch {
    return null;
  }
}

/**
 * The uid a custom token asserts, read the same two ways the sandbox reads it:
 * the `{ uid, claims }` payload the mint writes, plain or base64url encoded,
 * and the middle segment of a three-part token. Returns undefined for anything
 * else, and the sign-in itself then raises `auth/invalid-custom-token`.
 *
 * The uid is read here only to pin the tenant before the credential is
 * presented. Nothing about the token is verified.
 */
export function customTokenSubject(token: string): string | undefined {
  const parts = token.split('.');
  const segments = parts.length === 3 ? [parts[1] ?? ''] : [token];
  for (const segment of segments) {
    const payload = jsonFrom(segment);
    if (payload === null) continue;
    const uid = payload.uid ?? payload.sub;
    if (typeof uid === 'string' && uid.length > 0) return uid;
  }
  return undefined;
}

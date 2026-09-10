/**
 * Firestore rules simulation shared by the simulate and diagnose operations.
 *
 * Both run one case through the existing `firestore_simulate_rules` tool with
 * an ALLOW expectation and read the verdict off the result, so the two
 * operations differ in what they report rather than in how they evaluate.
 * The identity is the same projection the data plane uses, so a tenant
 * resolves as `request.auth.token.firebase.tenant` here too.
 */
import { getAuth, sandbox as authSandbox } from 'pyric/auth';
import { getClock } from 'pyric/sandbox';
import { inspect } from 'pyric/sandbox/firestore';
import { callSandboxTool } from './context.js';
import type { OperationResult, SurfaceContext } from './types.js';

export interface SimulationRequest {
  operation: 'get' | 'list' | 'create' | 'update' | 'delete';
  path: string;
  uid?: string;
  data?: Record<string, unknown>;
  rules?: string;
  /** ISO 8601 instant `request.time` evaluates at. Defaults to the sandbox clock. */
  requestTime?: string;
}

export interface SimulationOutcome {
  allowed: boolean;
  result: OperationResult;
  auth: { uid: string; token: Record<string, unknown> } | null;
}

/** The Firestore rules the sandbox is running, or the empty string when none are loaded. */
export function activeFirestoreRules(ctx: SurfaceContext): string {
  return inspect(ctx.sandbox).rules.source;
}

/**
 * The tenant and claims stored on a user record, so a simulation named by uid
 * runs as the identity that user really signs in as. A user seeded outside this
 * session has no remembered projection, and without this lookup it would
 * simulate untenanted and the verdict would explain the wrong denial.
 */
function storedIdentity(
  ctx: SurfaceContext,
  uid: string,
): { tenant?: string; claims?: Record<string, unknown> } {
  const stored = authSandbox.exportUsers(getAuth(ctx.sandbox)).find((user) => user.uid === uid);
  const identity: { tenant?: string; claims?: Record<string, unknown> } = {};
  if (stored?.tenantId !== undefined) identity.tenant = stored.tenantId;
  if (stored?.customClaims !== undefined) identity.claims = stored.customClaims;
  return identity;
}

/** The identity a simulation runs as: the named uid, or the held identity. */
function simulationAuth(
  ctx: SurfaceContext,
  uid: string | undefined,
): { uid: string; token: Record<string, unknown> } | null {
  if (uid !== undefined) {
    const stored = storedIdentity(ctx, uid);
    const projected = ctx.identity.projectionFor(uid, stored.tenant, stored.claims);
    return { uid: projected.uid, token: projected.token };
  }
  const held = ctx.identity.authState();
  if (held === null) return null;
  return { uid: held.uid, token: held.token ?? {} };
}

/** Run one case and report whether the rules allowed it. */
export async function simulateFirestoreCase(
  ctx: SurfaceContext,
  request: SimulationRequest,
): Promise<SimulationOutcome> {
  const source = request.rules ?? activeFirestoreRules(ctx);
  const auth = simulationAuth(ctx, request.uid);
  // `request.time` always names an instant, explicit or the sandbox clock's
  // own, so a simulation with no `requestTime` still moves with a pinned or
  // advanced clock rather than falling back to the engine's own wall clock.
  const requestTime = request.requestTime ?? getClock(ctx.sandbox).date().toISOString();
  const testCase: Record<string, unknown> = {
    description: `${request.operation} ${request.path}`,
    expectation: 'ALLOW',
    method: request.operation,
    path: request.path,
    auth,
    requestTime,
  };
  if (request.data !== undefined) testCase.data = request.data;

  const result = await callSandboxTool(ctx, 'firestore_simulate_rules', {
    source,
    testCases: [testCase],
  });
  const payload = result.data as { data?: { results?: Array<{ state?: string }> } } | undefined;
  const first = payload?.data?.results?.[0];
  return { allowed: first?.state === 'PASSED', result, auth };
}

/** The one case's full record, including the evaluation trace when the simulator produced one. */
export function simulationDetail(result: OperationResult): Record<string, unknown> | null {
  const payload = result.data as
    | { data?: { results?: Array<Record<string, unknown>> } }
    | undefined;
  return payload?.data?.results?.[0] ?? null;
}

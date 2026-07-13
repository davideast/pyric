/** Studio-owned operation contexts shared by in-process service adapters. */

import type { OperationContext, Sandbox, SandboxContext } from 'pyric/sandbox';
import { bindOperationContext } from 'pyric/sandbox/internal';

export const STUDIO_ADMIN_CONTEXT = Object.freeze({
  source: Object.freeze({ kind: 'studio' }),
  authLens: Object.freeze({ mode: 'admin' }),
}) satisfies OperationContext;

/** Bind Studio as the issuer and admin as the execution lens. */
export function studioAdminContext(sandbox: Sandbox): SandboxContext {
  return bindOperationContext(sandbox.withAuth(null), STUDIO_ADMIN_CONTEXT);
}

/**
 * Scenario-test helpers — let migrated scenario tests express
 * "given rules + seed, this op is allowed/denied" without the
 * try/catch/withAuth ceremony at every callsite.
 *
 * Why migrate scenario tests through `@pyric/sandbox` at all (rather
 * than continue using `LocalEnvironment.execute` directly):
 *
 *   - Scenario tests double as the largest corpus of "does this rule
 *     produce the right outcome?" assertions in the project. Running
 *     them through the public API confirms `getFirestore(...)` +
 *     `SandboxError` produce the same observable outcome as the raw
 *     rules engine. A future regression in the wrapper will fail one
 *     of these tests rather than silently diverging.
 *   - The helper keeps the migration mechanical: each old call to
 *     `env.execute({ method, path, auth, data })` becomes a one-liner
 *     `(await runOp(root, { method, path, auth, data })).allowed`,
 *     so behavior is preserved across the redesign with minimal noise.
 *
 * Identity model: the root sandbox holds rules + seeded state with no
 * identity attached. Every op derives its own context via
 * `root.withAuth(op.auth)` — multiple contexts share the underlying
 * data, only auth differs per op. This matches the multi-context
 * design's "sandboxes hold the data, contexts carry identity"
 * invariant.
 */

import { initializeSandbox, SandboxError, type Sandbox } from 'pyric/sandbox';
import { getFirestore, type DocumentData } from '../../../src/firestore/index.js';

/**
 * Mirror of the old `Operation` shape `LocalEnvironment.execute` accepts,
 * but constrained to what scenario tests actually use today.
 */
export type ScenarioOp =
  | { method: 'create' | 'update'; path: string; auth: { uid: string } | null; data: DocumentData }
  | { method: 'delete' | 'get'; path: string; auth: { uid: string } | null };

/**
 * Build a fresh sandbox with rules + seed in place. The setup uses an
 * anonymous context for the admin ops (`setRules` / `seed` bypass
 * rules anyway — auth doesn't matter); per-test code derives an
 * asserted identity via {@link runOp} or `root.withAuth(...)` directly.
 */
export function makeRoot(rules: string, documents: Record<string, DocumentData>): Sandbox {
  const sandbox = initializeSandbox();
  const db = getFirestore(sandbox.withAuth(null));
  db.setRules(rules);
  db.seed({ documents });
  return sandbox;
}

/**
 * Run a single operation under the requested identity by deriving a
 * context from the root. Returns `{ allowed: true }` if the op
 * completes; `{ allowed: false }` if it surfaces a
 * `permission-denied` SandboxError. Other codes (`not-found`, etc.)
 * propagate so they don't get silently swallowed as "denied."
 *
 * `set` is intentionally absent: the old scenario corpus uses `create`
 * (path absent in seed) and `update` (path present in seed) explicitly,
 * which matches how the rules engine treats them.
 */
export async function runOp(root: Sandbox, op: ScenarioOp): Promise<{ allowed: boolean }> {
  const db = getFirestore(root.withAuth(op.auth));
  try {
    switch (op.method) {
      case 'create':
        // The compat layer's `set()` dispatches to the rule's `create`
        // predicate when the path is absent — which is the contract
        // scenario tests rely on (they only ever call `create` for new
        // paths).
        await db.doc(op.path).set(op.data);
        return { allowed: true };
      case 'update':
        await db.doc(op.path).update(op.data);
        return { allowed: true };
      case 'delete':
        await db.doc(op.path).delete();
        return { allowed: true };
      case 'get':
        await db.doc(op.path).get();
        return { allowed: true };
    }
  } catch (e) {
    if (e instanceof SandboxError && e.code === 'permission-denied') {
      return { allowed: false };
    }
    throw e;
  }
}

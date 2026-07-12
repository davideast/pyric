/**
 * `sandbox_discover_paths` — discover the shape of the in-browser
 * simulator's data without sign-in, OAuth, or a real Firebase project.
 *
 * Mirror of the real-project `firestore_discover_paths` (diagnostic
 * tool, gated on sign-in) but pointed at the sandbox. The playground's
 * natural surface is the sandbox; this is what the agent should reach
 * for when the user asks about "my data" in playground context.
 *
 * Composition:
 *   - `createSandboxCrawlerFirestore` adapts `SandboxRunner.readState()`
 *     to the structural `CrawlerFirestore` contract the crawler
 *     consumes.
 *   - `createFirestoreDiscoverTools({ resolveDb })` from
 *     `@pyric/firestore/discover` returns the ToolHandler pair —
 *     we keep only the discover-paths half and rename it
 *     `sandbox_discover_paths` so it doesn't collide with the
 *     real-project diagnostic. The unused `find_collection_group`
 *     handler is harmlessly ignored — the sandbox-side crawler
 *     supports `collectionGroup` so it'd work, but the playground
 *     doesn't surface that tool today.
 */
import type { ToolHandler } from '@inbrowser/agent';
import { createFirestoreDiscoverTools } from '@pyric/cli/discover';
import { trimDiscoverResult } from '../diagnostics/firestore-discover';
import { createSandboxCrawlerFirestore } from '~/lib/sandbox/crawler-firestore';
import { readFirestoreState } from '~/lib/sandbox/runtime';

export function buildSandboxDiscoverHandler(): ToolHandler {
  return {
    name: 'sandbox_discover_paths',
    parallelSafe: true, // read-only (0.2.0 parallelDispatch)
    parameters: { type: 'object', properties: {} }, // takes no arguments
    description:
      "Discover the shape of the IN-BROWSER SANDBOX'S Firestore data. Returns per-collection schemas (field types, sampling info, subcollection paths) for every collection currently in the simulator. " +
      'Use this when the user asks about "my data", "what collections do I have", "show me my schema", or before generating rules/code that needs to know the shape of the data. ' +
      'This reads the sandbox state populated by prior `runOnce` calls or by your `writeCode` seeds — it does NOT need a signed-in Firebase project. If the sandbox is empty (no `runOnce` has populated it yet), the result will be empty; in that case write+run a seed first.',
    async execute(args, ctx) {
      const snapshot = await readFirestoreState();
      const firestore = createSandboxCrawlerFirestore(() => snapshot);
      // The sandbox crawler-firestore satisfies the structural
      // `CrawlerFirestore` subset `createFirestoreDiscoverTools` uses. The
      // `collectionGroup` method is also present (sandbox-backed), so the
      // shape line up cleanly — no admin-only methods are reachable.
      const tools = createFirestoreDiscoverTools({
        resolveDb: () => firestore as never,
      });
      const discover = tools.find((t) => t.name === 'firestore_discover_paths');
      if (!discover) {
        throw new Error(
          'sandbox_discover_paths: createFirestoreDiscoverTools did not return firestore_discover_paths — @pyric/firestore contract changed.',
        );
      }
      const result = await discover.execute(args, ctx);
      if (result.ok) return { ...result, data: trimDiscoverResult(result.data) };
      return result;
    },
  };
}

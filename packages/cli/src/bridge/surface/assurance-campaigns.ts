/**
 * The assurance run loop, reached from the service surface.
 *
 * The ten run-loop methods are the ten tools `createAssuranceTools` builds,
 * so the campaign vocabulary, the schemas behind each operation, and the
 * classification a probe result carries are the library's and not a second
 * copy of them. This module owns the two things the library leaves to its
 * host: which campaigns a call can see, and how a campaign clones the
 * sandbox it is judging.
 *
 * A campaign belongs to one sandbox. The store is keyed on the sandbox rather
 * than held as one process-wide value, so a second sandbox in the same
 * process, which is what a test suite is, never sees another sandbox's
 * campaigns or collides with its generated ids.
 */
import { getActiveRules } from 'pyric/sandbox/database';
import type { LocalSandbox } from 'pyric/sandbox';
import type { ToolContext } from '@inbrowser/agent';

import { createOwnedSandboxAttachmentProvider } from '../../assurance/attachment.js';
import type { AssuranceToolName } from '../../assurance/tool-names.js';
import {
  AssuranceCampaignStore,
  createAssuranceTools,
} from '../../assurance/tools.js';
import type { LocalFirebaseTarget } from '../../assurance/types.js';
import { activeFirestoreRules } from './rules-simulation.js';
import { operationFailure } from './context.js';
import type { Args } from './method-types.js';
import type { OperationResult, SurfaceContext } from './types.js';

/**
 * The URL an in-process attachment records as its source. A campaign started
 * by the process that owns the sandbox reached it through memory, and this is
 * the name that says so rather than a loopback address nothing was fetched
 * from.
 */
export const OWNED_SANDBOX_URL = 'pyric:in-process-sandbox';

/** One campaign store per sandbox, created the first time that sandbox is judged. */
const STORES = new WeakMap<LocalSandbox, AssuranceCampaignStore>();

/** The campaigns this sandbox holds. */
export function campaignStore(sandbox: LocalSandbox): AssuranceCampaignStore {
  const existing = STORES.get(sandbox);
  if (existing !== undefined) return existing;
  const created = new AssuranceCampaignStore();
  STORES.set(sandbox, created);
  return created;
}

/** The rules each service of this sandbox is enforcing, as a campaign target names them. */
export function sandboxRules(ctx: SurfaceContext): LocalFirebaseTarget['rules'] {
  const rules: LocalFirebaseTarget['rules'] = {};
  const firestore = activeFirestoreRules(ctx);
  if (firestore.length > 0) rules.firestore = firestore;
  const database = getActiveRules(ctx.sandbox);
  if (database !== null && database !== undefined) {
    rules.rtdb = database as { rules: Record<string, unknown> };
  }
  return rules;
}

/** The library tools, bound to this sandbox's campaigns and its own state. */
function assuranceTools(ctx: SurfaceContext) {
  return createAssuranceTools({
    store: campaignStore(ctx.sandbox),
    attachmentProvider: createOwnedSandboxAttachmentProvider(
      ctx.sandbox,
      sandboxRules(ctx),
      OWNED_SANDBOX_URL,
    ),
  });
}

/**
 * Run one assurance library operation and return its result in the shape
 * every surface method returns. The library reports its own failures as an
 * unsuccessful result rather than by throwing, so a failure that does reach
 * here is a defect and is reported as one instead of taking the process down.
 */
export async function callAssuranceOperation(
  ctx: SurfaceContext,
  name: AssuranceToolName,
  args: Args,
): Promise<OperationResult> {
  const tool = assuranceTools(ctx).find((candidate) => candidate.name === name);
  if (tool === undefined) throw new Error(`the assurance library has no tool '${name}'`);
  // The library's tools read nothing off the context but cancellation, and
  // nothing here cancels, so the signal of a controller nobody aborts is the
  // whole context one call needs.
  const toolContext: ToolContext = { signal: new AbortController().signal };
  try {
    const result = await tool.execute(args, toolContext);
    return { ok: result.ok, summary: result.summary, data: result.data };
  } catch (error) {
    return operationFailure(error instanceof Error ? error.message : String(error));
  }
}

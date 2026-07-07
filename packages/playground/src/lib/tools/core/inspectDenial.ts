/**
 * `inspect_denial` — investigate one sandbox denial in detail.
 *
 * Why a tool and not a prompt block: denial investigation is
 * event-shaped (tied to a specific denial that just happened),
 * intermittent (most turns don't involve denials), and benefits from
 * being VISIBLE in the chat as a tool call so the user can see the
 * agent decided to investigate — silent prompt-block correlation
 * looked indistinguishable from raw inference. The `denials-block`
 * still lists what just happened so the agent knows to call this.
 *
 * Behavior:
 *   - No args → target the MOST RECENT denial.
 *   - `path` → target the most-recent denial whose document path
 *     matches (e.g. `pyric_sessions/test`).
 */
import type { ToolHandler } from '@inbrowser/agent';
import { useRuntimeStore } from '~/lib/store/runtime';

interface InspectDenialArgs {
  path?: string;
}

type DenialBlurb = ReturnType<typeof useRuntimeStore.getState>['liveDenials'][number];

function pathOf(d: DenialBlurb): string | undefined {
  const env = d.request as { request?: { method?: string; path?: string } } | undefined;
  return env?.request?.path;
}

function methodOf(d: DenialBlurb): string | undefined {
  const env = d.request as { request?: { method?: string; path?: string } } | undefined;
  return env?.request?.method;
}

export const inspectDenialHandler: ToolHandler = {
  name: 'inspect_denial',
  parallelSafe: true, // read-only (0.2.0 parallelDispatch)
  description:
    'Investigate one sandbox denial in detail. By default targets the MOST RECENT denial — pass `path` to target a specific document path. Returns the denial details (op, auth, classification, message). Use this to explain why a denial happened — sandbox denials are evaluated against the editor rules body, so read /workspace/firestore.rules to correlate the denial to a rule clause.',
  parameters: {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description: 'Document path to look up (e.g. "pyric_sessions/test"). Omit to inspect the MOST RECENT denial in the runtime store.',
      },
    },
  },
  async execute(args) {
    const a = (args ?? {}) as InspectDenialArgs;
    const all = useRuntimeStore.getState().liveDenials;
    if (all.length === 0) {
      return {
        ok: false,
        summary: 'inspect_denial · no denials in the runtime store',
        data: { reason: 'no_denials' },
      };
    }

    let denial: DenialBlurb | undefined;
    if (a.path) {
      // Most-recent denial whose document path matches. Walk
      // newest-to-oldest so when multiple denials hit the same path,
      // the agent gets the freshest one.
      for (let i = all.length - 1; i >= 0; i--) {
        if (pathOf(all[i]!) === a.path) {
          denial = all[i];
          break;
        }
      }
      if (!denial) {
        return {
          ok: false,
          summary: `inspect_denial · no denial at path "${a.path}"`,
          data: { reason: 'path_not_found', knownPaths: Array.from(new Set(all.map(pathOf).filter(Boolean))) },
        };
      }
    } else {
      denial = all[all.length - 1];
    }

    const denialPath = pathOf(denial!);
    const denialOut = {
      at: denial!.at,
      op: denial!.op,
      path: denialPath,
      method: methodOf(denial!),
      auth: denial!.auth,
      message: denial!.message,
      classification: denial!.classification,
      classificationReason: denial!.classificationReason,
    };

    return {
      ok: true,
      summary: `inspect_denial · ${denialPath ?? denial!.op}`,
      data: { denial: denialOut },
    };
  },
};

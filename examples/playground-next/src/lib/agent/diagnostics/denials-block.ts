/**
 * Inline live-denials block. Pulls the most recent 10 sandbox denials
 * from the runtime store (App preview path) so the agent sees what
 * went wrong without having to re-exercise the app. Pyric-specific —
 * denials wouldn't otherwise reach the model since the App preview's
 * writes happen outside the agent loop.
 *
 * Listing only. The per-denial drill-down lives in the
 * `inspect_denial` tool (`~/lib/tools/core/inspectDenial.ts`) — the
 * agent calls it explicitly so the investigation is a visible tool
 * call rather than silent prompt-context inference.
 */
import { useRuntimeStore } from '~/lib/store/runtime';
import type { PromptBlock } from './index';

const MAX_RECENT = 10;

export const denialsBlock: PromptBlock = {
  heading: 'RECENT DENIALS (from App preview interactions, since last clear)',
  render() {
    const all = useRuntimeStore.getState().liveDenials;
    if (all.length === 0) return null;
    const recent = all.slice(-MAX_RECENT);
    const head = `${all.length} total denial${all.length === 1 ? '' : 's'} since last clear (showing ${recent.length} most recent):`;
    const rows = recent.map(
      (d) =>
        `- ${new Date(d.at).toLocaleTimeString()} · ${d.op} · auth: ${d.auth} · ${d.message}`,
    );
    return [head, ...rows].join('\n');
  },
};

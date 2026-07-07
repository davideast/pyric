/**
 * Cross-tab drill-navigation requests.
 *
 * The Suggestions panel (and other future surfaces) needs to drill
 * the user into a specific tool call or denial that lives on a
 * different top-tab. Rather than pass deep-link callbacks through
 * the whole component tree, a thin store carries the request: the
 * source panel writes `requestToolDrill(...)`, switches the active
 * tab, and the destination panel observes the pending request on
 * mount, applies its local drill state, and calls `clearPending()`.
 *
 * One pending request at a time — emitting a new one supersedes
 * whatever was queued.
 */
import { create } from 'zustand';

interface ToolDrill {
  kind: 'tool';
  messageId: string;
  callId: string;
}

interface DenialDrill {
  kind: 'denial';
  entryId: string;
}

type PendingDrill = ToolDrill | DenialDrill;

interface NavState {
  pending: PendingDrill | null;
  requestToolDrill(messageId: string, callId: string): void;
  requestDenialDrill(entryId: string): void;
  clearPending(): void;
}

export const useNavStore = create<NavState>()((set) => ({
  pending: null,
  requestToolDrill: (messageId, callId) =>
    set({ pending: { kind: 'tool', messageId, callId } }),
  requestDenialDrill: (entryId) =>
    set({ pending: { kind: 'denial', entryId } }),
  clearPending: () => set({ pending: null }),
}));

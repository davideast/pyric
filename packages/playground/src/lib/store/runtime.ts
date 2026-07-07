/**
 * Runtime store — the last sandbox interaction's results. The Output
 * tab subscribes to this; the manual Run button writes to it; the
 * agent's `runOnce` tool writes to it too. One source of truth so a
 * tool-driven run and a user-driven run land in the same panel.
 *
 * No history — only the latest run is kept. Phase 5 explicitly trades
 * the ability to scrub back through runs for a simpler model. If we
 * need an archive later it lives next to the existing chat history.
 */
import { create } from 'zustand';
import type { LogEntry } from '~/lib/sandbox/runner';
import type { RequestEvent, SandboxOperationEvent } from 'pyric/sandbox';

export interface DenialBlurb {
  id: string;
  at: number;
  /** "create users/alice", "update todos/abc" — terse summary. */
  op: string;
  /** Auth identity active when the denial fired, JSON-ish. */
  auth: string;
  /** First-line of the simulator's denial message. */
  message: string;
  /** Canonical Firestore-rules request shape for the denied op —
   *  same paths a rule reads (`request.method`, `request.path`,
   *  `request.auth`, `request.resource.data`, `resource.data`) so
   *  the user can copy this directly into a rules debugger / paste
   *  into a prompt. Built from the sandbox `DenialEvent`. */
  request: unknown;
  /** Static classification at capture time. `expected` means the
   *  app appears designed to handle this denial (rule fired as
   *  intended). `unexpected` means no error-handling code anticipates
   *  it. `ambiguous` is in-between. */
  classification: 'expected' | 'ambiguous' | 'unexpected';
  /** Single-line human reason for the classification badge. */
  classificationReason: string;
  /** Set true after the user clicks into the denial. Drives the
   *  "unread" counter on the Denials tab badge and the slim preview
   *  banner — both surface unacknowledged denials only. The denial
   *  stays in the panel either way; this just clears the alarm UI. */
  acknowledged?: boolean;
  /** Wall-clock when this denial was included in a batched analysis
   *  run. Denials without this stamp are "fresh" (unanalyzed) and
   *  get a small `new` chip in the Denials panel. Cleared / left
   *  unset when a denial fires after the last analysis ran. */
  analyzedAt?: number;
  /** Cached "Analyze & Explain" result — populated when the user runs
   *  the per-denial analyzer. Same shape as the tool-call drill-in's
   *  cached analysis so the surfaces feel unified. */
  analysis?: {
    text: string;
    thinking: string;
    telemetry: {
      providerLabel: string;
      modelLabel: string;
      durationMs: number;
      tokensIn: number;
      tokensOut: number;
      costUsd: number | null;
      costEstimated: boolean;
    };
    /** Follow-up suggestions. `action` kind submits the prompt to
     *  the agent on Send; `no-action` renders a disabled "No Action"
     *  chip. Sent / dismissed state is persisted on the suggestion
     *  itself so it survives tab switches that remount the panel. */
    suggestions?: Array<{
      kind: 'action' | 'no-action';
      label: string;
      confidence: number;
      rationale: string;
      prompt?: string;
      sent?: boolean;
      dismissed?: boolean;
    }>;
  };
}

const MAX_LIVE_DENIALS = 20;

/** Hard cap on the traffic ring buffer. From the probe data
 *  (`spike/traffic-monitor-probe/report.json`): 5000 events ≈ 3 MB
 *  worst case after `shrink` strips oversize `resourceData`. */
const MAX_TRAFFIC = 5000;

/**
 * One row in the Traffic panel — a `RequestEvent` from
 * `sandbox.onRequest` with playground-specific overlay fields. The
 * `eventId` of the source request is preserved so denial rows can
 * cross-reference the parallel `liveDenials` feed (classification,
 * acknowledgement, analyzedAt state) without duplicating storage.
 */
export type TrafficEntry = (RequestEvent | SandboxOperationEvent) & {
  /** True if a `resourceData` / `data` payload was truncated during
   *  shrink. The drill-in surfaces a hint when set. */
  truncated?: boolean;
};

export interface DeployMessage {
  severity: 'info' | 'warn' | 'error';
  text: string;
  line?: number;
  column?: number;
}

export interface DeploySnapshot {
  ok: boolean;
  messages: DeployMessage[];
  /** Wall-clock when the deploy attempt landed (for the panel header). */
  at: number;
}

export interface RunSnapshot {
  ok: boolean;
  durationMs: number;
  docsTouched: number;
  errors: number;
  entries: LogEntry[];
  /** True when this run was kicked off by the agent (not the manual button). */
  initiator: 'agent' | 'user';
  at: number;
}

/**
 * Single batched Analyze & Explain result for the current Denials
 * panel — one analysis covers the whole denial set rather than
 * one per row. Mirrors the per-tool-call analysis shape so the UI
 * can share `SuggestedPromptCard` etc. Cleared when the user clears
 * denials.
 */
export interface DenialsAnalysisSnapshot {
  text: string;
  thinking: string;
  telemetry: {
    providerLabel: string;
    modelLabel: string;
    durationMs: number;
    tokensIn: number;
    tokensOut: number;
    costUsd: number | null;
    costEstimated: boolean;
  };
  suggestions: Array<{
    kind: 'action' | 'no-action';
    label: string;
    confidence: number;
    rationale: string;
    prompt?: string;
    sent?: boolean;
    dismissed?: boolean;
  }>;
  /** Snapshot of denial IDs included in this analysis. Lets the UI
   *  tell when the underlying set has changed (new denial fired
   *  after the analysis ran) and prompt the user to re-analyze. */
  denialIds: string[];
  generatedAt: number;
}

interface RuntimeState {
  /** True while the deploy + execute round-trip is in flight. */
  isRunning: boolean;
  lastDeploy: DeploySnapshot | null;
  lastRun: RunSnapshot | null;
  /**
   * Live denial feed — projection over the traffic ring buffer for
   * `result === 'deny'` events with playground-specific overlay
   * state (classification, acknowledged, analyzedAt, analysis).
   * Capped separately at `MAX_LIVE_DENIALS` because we care about
   * recency-not-volume here.
   */
  liveDenials: DenialBlurb[];
  /** Cached batched analysis for the Denials panel. */
  denialsAnalysis: DenialsAnalysisSnapshot | null;
  /**
   * Every simulator op the user has seen this session. Capped 5000
   * (ring buffer). Fed by `sandbox.onRequest`. Denial entries also
   * push into `liveDenials` for the alarm + analyze paths.
   */
  traffic: TrafficEntry[];
  /** When true, new traffic events are dropped on arrival so the
   *  user can study a snapshot without scroll-jumps. */
  trafficPaused: boolean;
  setRunning(running: boolean): void;
  setLastDeploy(snap: DeploySnapshot | null): void;
  setLastRun(snap: RunSnapshot): void;
  pushDenial(blurb: DenialBlurb): void;
  patchDenial(id: string, patch: Partial<DenialBlurb>): void;
  setDenialsAnalysis(snap: DenialsAnalysisSnapshot | null): void;
  pushTraffic(entry: TrafficEntry): void;
  clearTraffic(): void;
  setTrafficPaused(paused: boolean): void;
  clearDenials(): void;
  clear(): void;
}

export const useRuntimeStore = create<RuntimeState>()((set) => ({
  isRunning: false,
  lastDeploy: null,
  lastRun: null,
  liveDenials: [],
  denialsAnalysis: null,
  traffic: [],
  trafficPaused: false,
  setRunning: (isRunning) => set({ isRunning }),
  setLastDeploy: (lastDeploy) => set({ lastDeploy }),
  setLastRun: (lastRun) => set({ lastRun }),
  pushDenial: (blurb) =>
    set((s) => ({
      liveDenials: [...s.liveDenials.slice(-(MAX_LIVE_DENIALS - 1)), blurb],
    })),
  patchDenial: (id, patch) =>
    set((s) => ({
      liveDenials: s.liveDenials.map((d) => (d.id === id ? { ...d, ...patch } : d)),
    })),
  setDenialsAnalysis: (denialsAnalysis) => set({ denialsAnalysis }),
  pushTraffic: (entry) =>
    set((s) => {
      if (s.trafficPaused) return {};
      return {
        traffic:
          s.traffic.length >= MAX_TRAFFIC
            ? [...s.traffic.slice(-(MAX_TRAFFIC - 1)), entry]
            : [...s.traffic, entry],
      };
    }),
  clearTraffic: () => set({ traffic: [] }),
  setTrafficPaused: (trafficPaused) => set({ trafficPaused }),
  clearDenials: () => set({ liveDenials: [], denialsAnalysis: null }),
  clear: () =>
    set({
      isRunning: false,
      lastDeploy: null,
      lastRun: null,
      liveDenials: [],
      denialsAnalysis: null,
      traffic: [],
      trafficPaused: false,
    }),
}));

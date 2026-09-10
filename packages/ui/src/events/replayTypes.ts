import type {
  Divergence,
  LocalSandbox,
  ReplayOptions,
  ReplayResult,
  SandboxEvent,
} from 'pyric/sandbox';

export type ReplayDivergenceKind =
  | 'real-divergence'
  | 'sentinel-drift'
  | 'time-drift'
  | 'autoid-alias'
  | 'now-denied'
  | 'now-allowed'
  | 'state-drift';

export interface SentinelDriftDivergence {
  kind: 'sentinel-drift';
  path: string;
  field: string;
  sentinelKind:
    | 'serverTimestamp'
    | 'increment'
    | 'arrayUnion'
    | 'arrayRemove'
    | 'delete';
  before: unknown;
  after: unknown;
}

export interface TimeDriftDivergence {
  kind: 'time-drift';
  path: string;
  field: string;
  before: unknown;
  after: unknown;
}

export interface AutoIdAliasDivergence {
  kind: 'autoid-alias';
  originalPath: string;
  replayedPath: string;
}

export interface RealDivergence {
  kind: 'real-divergence';
  path: string;
  field?: string;
  before: unknown;
  after: unknown;
}

export interface NowDeniedDivergence {
  kind: 'now-denied';
  path?: string;
  method?: string;
  reason?: string;
  service?: string;
  before?: unknown;
  after?: unknown;
}

export interface NowAllowedDivergence {
  kind: 'now-allowed';
  path?: string;
  method?: string;
  service?: string;
}

export interface StateDriftDivergence {
  kind: 'state-drift';
  path?: string;
  before: unknown;
  after: unknown;
}

export type ReplayDivergence =
  | SentinelDriftDivergence
  | TimeDriftDivergence
  | AutoIdAliasDivergence
  | RealDivergence
  | NowDeniedDivergence
  | NowAllowedDivergence
  | StateDriftDivergence
  | Divergence;

export interface DivergenceSummaryData {
  total: number;
  realCount: number;
  sentinelDriftCount: number;
  timeDriftCount: number;
  autoidAliasCount: number;
  nowDeniedCount: number;
  otherCount: number;
}

export interface SessionReplayOptions {
  /**
   * When true (default), re-issues captured request times so `serverTimestamp`
   * sentinels resolve to original capture times and time-gated rules evaluate
   * identically.
   */
  pinRequestTime?: boolean;
}

export interface SessionReplayResult {
  sandbox: LocalSandbox;
  divergences: ReplayDivergence[];
  pathAliases: Map<string, string>;
}

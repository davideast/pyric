/**
 * Structural context-window and token-usage contracts rendered by `@pyric/ui/agents`.
 *
 * Structurally assignable from `@inbrowser/agent/usage` (`ContextWindowSnapshot`,
 * `SessionRequestUsage`, `SessionTokenUsage`) so callers using `@inbrowser/agent`
 * pass snapshots directly without casts, while consumers of `@pyric/ui` ship
 * complete `.d.ts` definitions with zero runtime or peer dependency on `@inbrowser/agent`.
 */

export type ContextWindowStatus = 'unknown' | 'low' | 'medium' | 'high' | 'critical';

export interface ContextWindowBreakdownRow {
  id: string;
  label: string;
  tokens: number;
  color: string;
  estimated: boolean;
}

export interface ContextWindowCompactionStats {
  compacted: boolean;
  originalChars: number;
  compactedChars: number;
  bytesSaved: number;
  turnsCompacted: number;
  messagesCompacted: number;
}

export interface ContextWindowPromptCostEstimate {
  costUsd?: number;
  totalUsd?: number | null;
  promptUsd?: number | null;
  cachedPromptUsd?: number | null;
  estimated?: boolean;
  source?: string;
  inputPricePerMillion?: number;
  cacheReadPricePerMillion?: number;
}

export interface ContextWindowPricing {
  current: ContextWindowPromptCostEstimate | null;
  compacted: ContextWindowPromptCostEstimate | null;
  savedCostUsd: number | null;
}

export interface ContextWindowCompactionPreview {
  rawTokens: number;
  currentTokens: number;
  compactedTokens: number;
  automaticSavedTokens: number;
  manualSavedTokens: number;
  savedTokens: number;
  stats: ContextWindowCompactionStats;
  retains: readonly string[];
  loses: readonly string[];
}

export interface RequestInputComposition {
  system: number;
  history: number;
  resentToolResults: number;
  currentPrompt: number;
  toolSchemas: number;
}

export interface SessionToolRef {
  name: string;
  callId?: string;
  messageId?: string;
  tokens?: number;
  tokensEstimated?: number;
}

export interface SessionCacheInsight {
  hitRate: number;
  cachedTokens: number;
  freshTokens: number;
  knownMinimumTokens?: number;
  meetsKnownMinimum?: boolean;
  likelyStablePrefixTokens: number;
  providerMode: string;
  explanation: string;
}

export interface SessionRequestUsage {
  id: string;
  requestId: string;
  turnId: string;
  iteration: number;
  ts?: number;
  providerId?: string;
  providerLabel?: string;
  modelLabel?: string;
  strategy?: string;
  strategySource?: string;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  reasoningTokens: number;
  freshInputTokens: number;
  visibleOutputTokens: number;
  tokensTotal: number;
  costUsd?: number;
  usageSource: 'provider' | 'estimate';
  composition: RequestInputComposition;
  messageCount: number;
  toolResultMessageCount: number;
  toolNames: readonly string[];
  toolSchemaNames: readonly string[];
  emittedToolCalls: readonly SessionToolRef[];
  resentToolResults: readonly SessionToolRef[];
  cacheInsight?: SessionCacheInsight | string;
}

export interface SessionTurnUsage {
  id?: string;
  turnId?: string;
  label?: string;
  requestCount?: number | null;
  requests?: number;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  reasoningTokens: number;
  freshInputTokens?: number;
  visibleOutputTokens?: number;
  tokensTotal: number;
  costUsd?: number;
  multiplierContribution?: number;
}

export interface SessionUsageDetailRow {
  id: string;
  label: string;
  tokens: number;
  color: string;
  estimated: boolean;
  source: 'provider-reported' | 'estimated-from-traces';
  description: string;
}

export interface SessionUsageCategoryDetail {
  id?: string;
  label: string;
  tokens?: number;
  share?: number;
  source?: 'provider-reported' | 'estimated-from-traces' | 'mixed' | 'unavailable';
  note?: string;
  rows?: readonly SessionUsageDetailRow[];
}

export interface SessionTokenUsage {
  turns: number | null;
  requests: number | null;
  tokensTotal: number;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  reasoningTokens: number;
  costUsdTotal?: number;
  workMultiplier?: number;
  averageRequestTokens?: number;
  turnRows: readonly SessionTurnUsage[];
  requestRows: readonly SessionRequestUsage[];
  categoryDetails: Record<string, SessionUsageCategoryDetail | undefined>;
  teachingNotes?: {
    providerUsage: string;
    estimatedComposition: string;
    contextVsSpend: string;
  };
}

export interface ContextWindowSnapshot {
  basis: 'estimated-next-send';
  usedTokens: number;
  limitTokens?: number | null;
  percentFull?: number;
  status: ContextWindowStatus;
  breakdown: readonly ContextWindowBreakdownRow[];
  compaction: ContextWindowCompactionStats;
  compactionPreview: ContextWindowCompactionPreview;
  pricing: ContextWindowPricing;
  toolCount: number;
  sessionUsage?: SessionTokenUsage;
}

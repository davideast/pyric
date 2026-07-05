declare module '@inbrowser/agent/usage' {
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

  export interface ContextWindowPricingEstimate {
    totalUsd: number | null;
    promptUsd: number | null;
    cachedPromptUsd?: number | null;
  }

  export interface ContextWindowPricing {
    current: ContextWindowPricingEstimate | null;
    compacted: ContextWindowPricingEstimate | null;
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
    callId: string;
    messageId?: string;
    tokens?: number;
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
    cacheInsight?: string;
  }

  export interface SessionTurnUsage {
    turnId: string;
    inputTokens: number;
    outputTokens: number;
    cachedInputTokens: number;
    reasoningTokens: number;
    tokensTotal: number;
    requests: number;
    costUsd?: number;
  }

  export interface SessionUsageCategoryDetail {
    label: string;
    tokens: number;
    share?: number;
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
    categoryDetails: Record<string, SessionUsageCategoryDetail>;
    teachingNotes?: {
      providerUsage: string;
      estimatedComposition: string;
      contextVsSpend: string;
    };
  }

  export interface ContextWindowSnapshot {
    basis: 'estimated-next-send';
    usedTokens: number;
    limitTokens: number | null;
    percentFull?: number;
    status: ContextWindowStatus;
    breakdown: readonly ContextWindowBreakdownRow[];
    compaction: ContextWindowCompactionStats;
    compactionPreview: ContextWindowCompactionPreview;
    pricing: ContextWindowPricing;
    toolCount: number;
    sessionUsage?: SessionTokenUsage;
  }
}

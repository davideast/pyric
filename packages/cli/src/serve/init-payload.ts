/** Browser-safe wire contract served by `/__pyric/init.json`. */
export interface InitPayload {
  /** Per-server capability for the warning-only activity report endpoint. */
  activityToken?: string;
  rules: string | null;
  rulesHash: string | null;
  databaseRules?: { rules: Record<string, unknown> } | null;
  databaseRulesHash?: string | null;
  databaseUrl?: string | null;
  /** Storage rules are installed once, before the first Storage operation. */
  storageRules: string | null;
  storageRulesHash: string | null;
  bridgeUrl: string | null;
  seed: Record<string, Record<string, unknown>> | null;
  persist?: boolean;
  seedState?: unknown | null;
  authUsers?: ReadonlyArray<Record<string, unknown>> | null;
  capture?: boolean;
  messaging?: boolean;
}

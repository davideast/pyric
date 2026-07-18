/** Browser-safe wire contract served by `/__pyric/init.json`. */
export interface InitPayload {
  rules: string | null;
  rulesHash: string | null;
  databaseRules?: { rules: Record<string, unknown> } | null;
  databaseRulesHash?: string | null;
  databaseUrl?: string | null;
  /** Storage rules are installed once, before the first Storage operation. */
  storageRules: string | null;
  storageRulesHash: string | null;
  /**
   * Local project identity — the served project directory. Scopes the
   * storage IndexedDB database name (`pyric-storage:<projectKey>`, issue
   * #359): IndexedDB is origin-scoped, so without this every project served
   * on one localhost port shared one storage database. Local-only (a dev
   * server path never leaves the machine). Absent/null on older servers —
   * consumers fall back to the legacy shared name.
   */
  projectKey?: string | null;
  bridgeUrl: string | null;
  seed: Record<string, Record<string, unknown>> | null;
  persist?: boolean;
  seedState?: unknown | null;
  authUsers?: ReadonlyArray<Record<string, unknown>> | null;
  capture?: boolean;
  messaging?: boolean;
}

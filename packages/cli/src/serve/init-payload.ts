import type { AiEngineConfigWire } from './worker/protocol.js';

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
  /**
   * Plugin-level AI config (`@pyric/cli/vite`'s `ai.engine`). Only the ENGINE
   * travels here — the OpenAI proxy upstream is a server-side namespace option
   * that never reaches the page. The worker host reads `ai.engine` into
   * `ctx.aiEngine`, which wins over any op-carried `engine` (see host-ai.ts).
   * Absent under `pyric dev` (no CLI surface) and whenever the plugin sets no
   * engine. The in-page fallback path receives the same engine synchronously
   * via the injected `globalThis.__PYRIC_AI_ENGINE__` (init.json can't be read
   * synchronously by the served `getAI`).
   */
  ai?: { engine?: AiEngineConfigWire } | null;
}

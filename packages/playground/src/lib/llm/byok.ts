/**
 * BYOK — bring-your-own-key. localStorage-backed per-provider, with an
 * optional session-scoped backend for `apiKey` slots.
 *
 * Why client-side: this is a static Astro site. No backend means no
 * shared key store; the only honest answer is "your browser, your
 * machine, your key." Users get a clear note in the modal copy.
 *
 * One slot per provider — `byokFor(providerId)` returns the slot for
 * that provider. Keys are namespaced under `pyric.playground.byok.<id>`
 * so adding a new provider doesn't risk colliding with an existing key.
 *
 * Slot kinds. Most providers ("apiKey") only need a secret string;
 * Ollama is local-first and needs a base URL instead ("baseUrl"). The
 * discriminated union lets the BYOK UI render the right input control
 * without each call site special-casing per-provider id. The storage
 * surface (`hasKey`/`getKey`/`setKey`/`clearKey`) is identical across
 * kinds — for `baseUrl` slots, "key" is the URL string. `clearKey` on
 * a `baseUrl` slot resets to the `defaultBaseUrl`, not to absent —
 * Ollama is useless without one and `http://localhost:11434` is the
 * upstream default.
 *
 * Session-backed keys (`apiKey` slots only). A key can live in
 * `sessionStorage` instead of `localStorage` — used for OpenRouter's
 * OAuth-provisioned keys, which default to the tab's lifetime rather
 * than surviving indefinitely on disk. One storage key, one mechanism:
 * `getKey()`/`hasKey()` check `sessionStorage` first, then fall back to
 * `localStorage`, so callers that only care about "is there a usable
 * key" never need to know which backend holds it. `setKey(key, {
 * backend })` picks where a *new* value lands (default `'local'`,
 * preserving the historical manually-pasted-key behavior).
 * `promoteToLocal()` moves a session-backed key to `localStorage`
 * ("remember on this device") without ever holding the secret in two
 * places at once.
 */
const PREFIX = 'pyric.playground.byok.';

/** Where a key value is persisted. `'session'` clears when the tab
 *  closes; `'local'` survives indefinitely (the historical default). */
export type ByokBackend = 'local' | 'session';

interface ByokSlotBase {
  /** Display label (e.g. "Gemini API key"). */
  label: string;
  /** Where the user can get a key / set up the provider. */
  helpUrl: string;
  /** Persistent key check. For `baseUrl` slots, the default URL counts. */
  hasKey(): boolean;
  /** Read the key (synchronous; returns null when absent). */
  getKey(): string | null;
  /** Persist a key. */
  setKey(key: string): void;
  /** Clear the persisted key. */
  clearKey(): void;
}

export interface ApiKeyByokSlot extends ByokSlotBase {
  kind: 'apiKey';
  /** True when a key is currently held in the session-scoped backend
   *  specifically (as opposed to `localStorage`). Drives the "remember
   *  on this device" affordance in the key UI — offering to promote a
   *  key that's already local would be a no-op. */
  hasSessionKey(): boolean;
  /** Persist a key. `opts.backend` picks the storage backend for THIS
   *  write (default `'local'`) — it does not touch a value already
   *  sitting in the other backend, so callers that want a clean switch
   *  should `clearKey()` first (see `promoteToLocal` for the one case
   *  that needs it). */
  setKey(key: string, opts?: { backend?: ByokBackend }): void;
  /** Move a session-backed key to `localStorage` ("remember on this
   *  device"). No-op when there is no session-backed key. */
  promoteToLocal(): void;
}

export interface BaseUrlByokSlot extends ByokSlotBase {
  kind: 'baseUrl';
  /** Fallback URL used when the user hasn't customized one. */
  defaultBaseUrl: string;
  /** Raw stored value (null when absent). Distinguishes "user set a
   *  URL" from "we returned the default" — `getKey()` collapses both
   *  cases. Callers that need to know whether the user explicitly
   *  chose a value (e.g. precedence vs. an env-var default) use this. */
  getStoredKey(): string | null;
}

export type ByokSlot = ApiKeyByokSlot | BaseUrlByokSlot;

function safeLocalStorage(): Storage | null {
  try {
    return typeof window !== 'undefined' ? window.localStorage : null;
  } catch {
    return null;
  }
}

function safeSessionStorage(): Storage | null {
  try {
    return typeof window !== 'undefined' ? window.sessionStorage : null;
  } catch {
    return null;
  }
}

function safeStorage(backend: ByokBackend): Storage | null {
  return backend === 'session' ? safeSessionStorage() : safeLocalStorage();
}

function createApiKeySlot(id: string, label: string, helpUrl: string): ApiKeyByokSlot {
  const storageKey = `${PREFIX}${id}`;
  return {
    kind: 'apiKey',
    label,
    helpUrl,
    hasKey() {
      return (
        !!safeStorage('session')?.getItem(storageKey) ||
        !!safeStorage('local')?.getItem(storageKey)
      );
    },
    hasSessionKey() {
      return !!safeStorage('session')?.getItem(storageKey);
    },
    getKey() {
      // Session-backed keys win over a stale localStorage value — a
      // freshly-completed OAuth sign-in should take effect immediately
      // even if an older manually-pasted key is still on disk.
      return (
        safeStorage('session')?.getItem(storageKey) ??
        safeStorage('local')?.getItem(storageKey) ??
        null
      );
    },
    setKey(key, opts) {
      const backend = opts?.backend ?? 'local';
      const store = safeStorage(backend);
      if (!store) return;
      const trimmed = key.trim();
      if (trimmed.length === 0) store.removeItem(storageKey);
      else store.setItem(storageKey, trimmed);
    },
    clearKey() {
      safeStorage('session')?.removeItem(storageKey);
      safeStorage('local')?.removeItem(storageKey);
    },
    promoteToLocal() {
      const session = safeStorage('session');
      const value = session?.getItem(storageKey);
      if (!value) return;
      const local = safeStorage('local');
      if (!local) return;
      local.setItem(storageKey, value);
      session?.removeItem(storageKey);
    },
  };
}

function createBaseUrlSlot(
  id: string,
  label: string,
  helpUrl: string,
  defaultBaseUrl: string,
): BaseUrlByokSlot {
  const storageKey = `${PREFIX}${id}`;
  return {
    kind: 'baseUrl',
    label,
    helpUrl,
    defaultBaseUrl,
    hasKey() {
      // baseUrl slots always have a usable value — either a stored
      // override or the default. The UI uses this to decide whether
      // a config step is required before activating a provider; for
      // baseUrl-kind providers, the default is good enough on its own.
      return true;
    },
    getKey() {
      const ls = safeLocalStorage();
      const stored = ls?.getItem(storageKey);
      return stored && stored.trim().length > 0 ? stored : defaultBaseUrl;
    },
    getStoredKey() {
      const ls = safeLocalStorage();
      const stored = ls?.getItem(storageKey);
      return stored && stored.trim().length > 0 ? stored : null;
    },
    setKey(key) {
      const ls = safeLocalStorage();
      if (!ls) return;
      const trimmed = key.trim();
      if (trimmed.length === 0) ls.removeItem(storageKey);
      else ls.setItem(storageKey, trimmed);
    },
    clearKey() {
      const ls = safeLocalStorage();
      ls?.removeItem(storageKey);
    },
  };
}

export const geminiByok: ApiKeyByokSlot = createApiKeySlot(
  'gemini',
  'Gemini API key',
  'https://aistudio.google.com/apikey',
);

export const openrouterByok: ApiKeyByokSlot = createApiKeySlot(
  'openrouter',
  'OpenRouter API key',
  'https://openrouter.ai/keys',
);

export const ollamaByok: BaseUrlByokSlot = createBaseUrlSlot(
  'ollama',
  'Ollama base URL',
  'https://github.com/ollama/ollama/blob/main/docs/faq.md#how-do-i-configure-ollama-server',
  'http://localhost:11434',
);

export const llamaServerByok: BaseUrlByokSlot = createBaseUrlSlot(
  'llamaServer',
  'llama.cpp server base URL',
  'https://github.com/ggml-org/llama.cpp/tree/master/tools/server',
  'http://localhost:8080',
);

export const BYOK_SLOTS = {
  gemini: geminiByok,
  openrouter: openrouterByok,
  ollama: ollamaByok,
  llamaServer: llamaServerByok,
} as const;

export type ByokProviderId = keyof typeof BYOK_SLOTS;

/**
 * URL validator for baseUrl-kind slots. Returns null when valid; an
 * error string when not. Pulled out so the form component can call it
 * synchronously on input change without duplicating the rules.
 */
export function validateBaseUrl(value: string): string | null {
  const trimmed = value.trim();
  if (trimmed.length === 0) return 'URL is required';
  if (!/^https?:\/\//i.test(trimmed)) return 'Must start with http:// or https://';
  try {
    const u = new URL(trimmed);
    if (!u.hostname) return 'Missing hostname';
    return null;
  } catch {
    return 'Invalid URL';
  }
}

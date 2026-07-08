/**
 * BYOK — bring-your-own-key. localStorage-backed per-provider.
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
 */
const PREFIX = 'pyric.playground.byok.';

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

function createApiKeySlot(id: string, label: string, helpUrl: string): ApiKeyByokSlot {
  const storageKey = `${PREFIX}${id}`;
  return {
    kind: 'apiKey',
    label,
    helpUrl,
    hasKey() {
      const ls = safeLocalStorage();
      return ls ? !!ls.getItem(storageKey) : false;
    },
    getKey() {
      const ls = safeLocalStorage();
      return ls ? ls.getItem(storageKey) : null;
    },
    setKey(key) {
      const ls = safeLocalStorage();
      if (!ls) return;
      if (key.trim().length === 0) ls.removeItem(storageKey);
      else ls.setItem(storageKey, key.trim());
    },
    clearKey() {
      const ls = safeLocalStorage();
      ls?.removeItem(storageKey);
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

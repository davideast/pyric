/**
 * BYOK (bring-your-own-key) for Studio AI assists, localStorage-backed per
 * provider. Ported from the playground's `lib/llm/byok.ts`, trimmed to the two
 * slot kinds Studio needs.
 *
 * Why client-side: served Studio (`pyric serve --ui`) is static-ish with no key
 * store of its own, so the honest answer is "your browser, your machine, your
 * key." Studio is an admin-scoped console; the settings page states this plainly
 * and recommends a scoped / dev key. The keyless alternative (a `pyric serve`
 * relay that holds the key server-side) is a follow-up behind the same seam.
 *
 * One slot per provider, namespaced under `pyric.studio.byok.<id>`. Most
 * providers ("apiKey") need a secret string; Ollama is local-first and needs a
 * base URL instead ("baseUrl"). The discriminated union lets the settings UI
 * render the right control without special-casing per provider.
 */

const PREFIX = 'pyric.studio.byok.';

function safeLocalStorage(): Storage | null {
  try {
    return typeof window !== 'undefined' ? window.localStorage : null;
  } catch {
    return null;
  }
}

// Key changes are reactive: setting/clearing a key bumps a version so consumers
// (e.g. `useLlmClient`, which derives the live client from the active key) can
// re-render. Without this, saving a key in settings would not enable assists
// until an unrelated re-render.
let keysVersion = 0;
const keyListeners = new Set<() => void>();

function notifyKeysChanged(): void {
  keysVersion++;
  for (const l of keyListeners) l();
}

export function subscribeKeys(cb: () => void): () => void {
  keyListeners.add(cb);
  return () => keyListeners.delete(cb);
}

export function keysVersionSnapshot(): number {
  return keysVersion;
}

interface ByokSlotBase {
  /** Display label (e.g. "Anthropic API key"). */
  label: string;
  /** Where the user gets a key / sets the provider up. */
  helpUrl: string;
  /** Persistent key check. For `baseUrl` slots, the default URL counts. */
  hasKey(): boolean;
  /** Read the key (sync; null when absent). For `baseUrl`, the URL string. */
  getKey(): string | null;
  /** Persist a key. */
  setKey(key: string): void;
  /** Clear the persisted key (a `baseUrl` slot resets to its default). */
  clearKey(): void;
}

export interface ApiKeyByokSlot extends ByokSlotBase {
  kind: 'apiKey';
}

export interface BaseUrlByokSlot extends ByokSlotBase {
  kind: 'baseUrl';
  /** Fallback URL used when the user has not customized one. */
  defaultBaseUrl: string;
  /** Raw stored value (null when absent): distinguishes "user set a URL" from
   *  "we returned the default" (which `getKey()` collapses). */
  getStoredKey(): string | null;
}

export type ByokSlot = ApiKeyByokSlot | BaseUrlByokSlot;

export function createApiKeySlot(id: string, label: string, helpUrl: string): ApiKeyByokSlot {
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
    setKey(key: string) {
      safeLocalStorage()?.setItem(storageKey, key);
      notifyKeysChanged();
    },
    clearKey() {
      safeLocalStorage()?.removeItem(storageKey);
      notifyKeysChanged();
    },
  };
}

export function createBaseUrlSlot(
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
      // A baseUrl slot is always usable: absent means "use the default URL".
      return true;
    },
    getStoredKey() {
      const ls = safeLocalStorage();
      return ls ? ls.getItem(storageKey) : null;
    },
    getKey() {
      const ls = safeLocalStorage();
      return (ls ? ls.getItem(storageKey) : null) ?? defaultBaseUrl;
    },
    setKey(url: string) {
      safeLocalStorage()?.setItem(storageKey, url);
      notifyKeysChanged();
    },
    clearKey() {
      // Reset to the default rather than absent: Ollama is useless without a URL.
      safeLocalStorage()?.removeItem(storageKey);
      notifyKeysChanged();
    },
  };
}

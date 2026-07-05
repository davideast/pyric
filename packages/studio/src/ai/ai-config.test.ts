import { describe, expect, it, beforeEach } from 'bun:test';

// The studio test env has no DOM, so mock window.localStorage. byok + llm-store
// read it per-operation, so setting it before the tests run is sufficient (the
// modules' load-time read in llm-store just sees no storage and uses defaults).
const lsStore = new Map<string, string>();
(globalThis as unknown as { window: unknown }).window = {
  localStorage: {
    getItem: (k: string) => lsStore.get(k) ?? null,
    setItem: (k: string, v: string) => {
      lsStore.set(k, v);
    },
    removeItem: (k: string) => {
      lsStore.delete(k);
    },
  },
};

import { createApiKeySlot, createBaseUrlSlot, subscribeKeys, keysVersionSnapshot } from './byok.js';
import {
  PROVIDERS,
  PROVIDER_LIST,
  DEFAULT_PROVIDER_ID,
  DEFAULT_MODEL_ID,
  providerById,
  modelsFor,
} from './providers.js';
import { setProvider, setModel, setEffort, getSelection } from './llm-store.js';

describe('providers registry', () => {
  it('defaults to Claude Opus 4.8', () => {
    expect(DEFAULT_PROVIDER_ID).toBe('anthropic');
    expect(DEFAULT_MODEL_ID).toBe('claude-opus-4-8');
  });

  it('lists Claude first', () => {
    expect(PROVIDER_LIST[0]!.id).toBe('anthropic');
    expect(PROVIDER_LIST.map((p) => p.id)).toEqual(['anthropic', 'openrouter', 'gemini', 'ollama']);
  });

  it('exposes each provider default model within its own list', () => {
    for (const def of PROVIDER_LIST) {
      expect(def.models.some((m) => m.id === def.defaultModelId)).toBe(true);
    }
  });

  it('looks up providers + models', () => {
    expect(providerById('anthropic').label).toBe('Claude (Anthropic)');
    expect(modelsFor('anthropic').some((m) => m.id === 'claude-opus-4-8')).toBe(true);
    expect(PROVIDERS.ollama.byok.kind).toBe('baseUrl');
    expect(PROVIDERS.anthropic.byok.kind).toBe('apiKey');
  });
});

describe('byok slots', () => {
  beforeEach(() => lsStore.clear());

  it('apiKey slot set/get/has/clear', () => {
    const slot = createApiKeySlot('test-x', 'Test key', 'https://example.com');
    expect(slot.hasKey()).toBe(false);
    expect(slot.getKey()).toBeNull();
    slot.setKey('sk-abc');
    expect(slot.hasKey()).toBe(true);
    expect(slot.getKey()).toBe('sk-abc');
    slot.clearKey();
    expect(slot.hasKey()).toBe(false);
  });

  it('baseUrl slot returns default until set, then the stored value', () => {
    const slot = createBaseUrlSlot('test-ollama', 'Base URL', 'https://h', 'http://localhost:11434');
    expect(slot.hasKey()).toBe(true); // always usable (default URL)
    expect(slot.getStoredKey()).toBeNull();
    expect(slot.getKey()).toBe('http://localhost:11434');
    slot.setKey('http://box:9999');
    expect(slot.getStoredKey()).toBe('http://box:9999');
    expect(slot.getKey()).toBe('http://box:9999');
    slot.clearKey();
    expect(slot.getKey()).toBe('http://localhost:11434');
  });

  it('namespaces keys so providers do not collide', () => {
    createApiKeySlot('p-a', 'A', '').setKey('key-a');
    createApiKeySlot('p-b', 'B', '').setKey('key-b');
    expect(createApiKeySlot('p-a', 'A', '').getKey()).toBe('key-a');
    expect(createApiKeySlot('p-b', 'B', '').getKey()).toBe('key-b');
  });

  it('is reactive: setKey/clearKey bump the version + notify (so useLlmClient re-derives)', () => {
    let notified = 0;
    const unsub = subscribeKeys(() => notified++);
    const v0 = keysVersionSnapshot();
    const slot = createApiKeySlot('reactive-x', 'X', '');
    slot.setKey('k');
    expect(keysVersionSnapshot()).toBeGreaterThan(v0);
    expect(notified).toBeGreaterThan(0);
    slot.clearKey();
    expect(keysVersionSnapshot()).toBeGreaterThan(v0 + 1);
    unsub();
  });
});

describe('llm selection store', () => {
  beforeEach(() => {
    lsStore.clear();
    setProvider('anthropic');
    setModel('claude-opus-4-8');
    setEffort('medium');
  });

  it('selecting a provider snaps the model to that provider default', () => {
    setProvider('gemini');
    expect(getSelection().providerId).toBe('gemini');
    expect(getSelection().modelId).toBe(PROVIDERS.gemini.defaultModelId);
  });

  it('setModel rejects a model not in the active provider list', () => {
    setProvider('anthropic');
    setModel('gemini-3.5-flash'); // not an anthropic model
    expect(getSelection().modelId).toBe(PROVIDERS.anthropic.defaultModelId);
    setModel('claude-sonnet-4-6'); // valid anthropic model
    expect(getSelection().modelId).toBe('claude-sonnet-4-6');
  });

  it('persists the selection + effort to localStorage', () => {
    setProvider('openrouter');
    setEffort('high');
    expect(lsStore.get('pyric.studio.llm.selection')).toContain('openrouter');
    expect(lsStore.get('pyric.studio.openrouter.effort')).toBe('high');
  });
});

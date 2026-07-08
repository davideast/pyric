/**
 * API-keys settings page (BYOK) for Studio AI assists. A modal (the palette's
 * backdrop pattern) with one section per provider: a key field (or base URL for
 * Ollama), Save / Clear, a Test button that makes one cheap inference call, and a
 * status badge. Keys live in `localStorage` (per `byok.ts`); the page states this
 * plainly. Reachable from the spine gear, the command palette, and `#settings`.
 */

import { useEffect, useMemo, useState } from 'react';
import { PROVIDER_LIST, PROVIDERS, providerUnavailableReason, type ProviderId } from './providers.js';
import { makeLlmClient } from './inference.js';
import { ModelSelector } from './ModelSelector.js';
import './ai.css';

type TestState =
  | { kind: 'idle' }
  | { kind: 'testing' }
  | { kind: 'ok'; message: string }
  | { kind: 'error'; message: string };

/** One cheap inference call to validate a key. Surfaces the real outcome
 *  (including a CORS error for browser-blocked providers, which is useful). */
async function testKey(providerId: ProviderId, apiKey: string): Promise<TestState> {
  const def = PROVIDERS[providerId];
  const client = makeLlmClient({ providerId, model: def.defaultModelId, apiKey });
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 20000);
  try {
    for await (const ev of client.chat(
      { messages: [{ role: 'user', text: 'ping' }], tools: [], toolUseEnabled: false },
      ctrl.signal,
    )) {
      if (ev.kind === 'error') return { kind: 'error', message: ev.message };
      // `usage` is the normal terminal event (the turn ends when the stream
      // returns; a `usage` event precedes it). Reaching it means the call
      // round-tripped, so the key works.
      if (ev.kind === 'usage') return { kind: 'ok', message: 'Key works.' };
    }
    return { kind: 'ok', message: 'Key works.' };
  } catch (e) {
    return { kind: 'error', message: e instanceof Error ? e.message : String(e) };
  } finally {
    clearTimeout(timer);
  }
}

function ProviderRow({ providerId }: { providerId: ProviderId }) {
  const def = PROVIDERS[providerId];
  const slot = def.byok;
  const isUrl = slot.kind === 'baseUrl';
  const unavailableReason = providerUnavailableReason(def);
  const [draft, setDraft] = useState(() => slot.getKey() ?? '');
  const [saved, setSaved] = useState(() => slot.hasKey());
  const [test, setTest] = useState<TestState>({ kind: 'idle' });

  const save = () => {
    if (draft.trim()) {
      slot.setKey(draft.trim());
      setSaved(true);
      setTest({ kind: 'idle' });
    }
  };
  const clear = () => {
    slot.clearKey();
    setDraft(isUrl ? slot.getKey() ?? '' : '');
    setSaved(slot.hasKey());
    setTest({ kind: 'idle' });
  };
  const runTest = async () => {
    setTest({ kind: 'testing' });
    setTest(await testKey(providerId, draft.trim()));
  };

  return (
    <section className="ai-set__row" data-pyric-provider={providerId}>
      <div className="ai-set__rowhead">
        <span className="ai-set__name">{def.label}</span>
        <span className="ai-set__status" data-state={unavailableReason ? 'unavailable' : saved ? 'set' : 'unset'}>
          {unavailableReason ? 'unavailable' : saved ? 'key set' : 'no key'}
        </span>
      </div>
      <div className="ai-set__field">
        <input
          className="ai-set__input"
          type={isUrl ? 'text' : 'password'}
          value={draft}
          spellCheck={false}
          autoComplete="off"
          placeholder={isUrl ? 'http://localhost:11434' : slot.label}
          onChange={(e) => setDraft(e.target.value)}
          disabled={!!unavailableReason}
        />
        <button
          type="button"
          className="ai-set__btn ai-set__btn--primary"
          onClick={save}
          disabled={!!unavailableReason || !draft.trim()}
        >
          Save
        </button>
        <button type="button" className="ai-set__btn" onClick={clear}>
          Clear
        </button>
        <button
          type="button"
          className="ai-set__btn"
          onClick={() => void runTest()}
          disabled={!!unavailableReason || !draft.trim() || test.kind === 'testing'}
        >
          {test.kind === 'testing' ? 'Testing…' : 'Test'}
        </button>
      </div>
      {unavailableReason ? (
        <p className="ai-set__test" data-state="error">
          {unavailableReason}
        </p>
      ) : test.kind === 'ok' || test.kind === 'error' ? (
        <p className="ai-set__test" data-state={test.kind}>
          {test.message}
        </p>
      ) : null}
      {!unavailableReason ? (
        <a className="ai-set__help" href={slot.helpUrl} target="_blank" rel="noreferrer">
          Get a key for {def.label} →
        </a>
      ) : null}
    </section>
  );
}

export function SettingsContent({
  headingId,
  showClose,
  onClose,
}: {
  headingId?: string;
  showClose?: boolean;
  onClose?: () => void;
}) {
  const providers = useMemo(() => PROVIDER_LIST.map((p) => p.id), []);

  return (
    <>
      <header className="ai-set__head">
        <h2 id={headingId} className="ai-set__title">AI settings</h2>
        {showClose && onClose ? (
          <button type="button" className="ai-set__close" onClick={onClose} aria-label="Close">
            esc
          </button>
        ) : null}
      </header>
      <p className="ai-set__note">
        Bring your own key. Keys are stored in this browser's localStorage and never
        leave it. Studio is an admin console, so prefer a scoped or dev key. A
        server-side relay (no key in the browser) is a later option.
      </p>
      <div className="ai-set__model">
        <span className="ai-set__modellabel">Model for assists</span>
        <ModelSelector />
      </div>
      <div className="ai-set__rows">
        {providers.map((id) => (
          <ProviderRow key={id} providerId={id} />
        ))}
      </div>
    </>
  );
}

export function SettingsModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  // Esc closes.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div className="studio__palette-backdrop" onMouseDown={onClose}>
      <div
        className="ai-set"
        role="dialog"
        aria-modal="true"
        aria-labelledby="ai-settings-modal-title"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <SettingsContent headingId="ai-settings-modal-title" showClose onClose={onClose} />
      </div>
    </div>
  );
}

/**
 * The model selector in the spine: a compact button showing the active model,
 * opening a menu grouped by provider. Providers without a key are locked with a
 * "Set key" link into the settings page. The selection is global (every assist's
 * `LlmClient` reads it), persisted via `useLlmSelection`.
 */

import { useState } from 'react';
import { PROVIDER_LIST, PROVIDERS, providerUnavailableReason } from './providers.js';
import { useLlmSelection } from './llm-store.js';
import { openSettings } from './settings-store.js';
import './ai.css';

export function ModelSelector() {
  const { providerId, modelId, setProvider, setModel } = useLlmSelection();
  const [open, setOpen] = useState(false);

  const activeProvider = PROVIDERS[providerId];
  const activeModel = activeProvider.models.find((m) => m.id === modelId);
  const activeLabel = activeModel?.label ?? modelId;
  const activeReady = !providerUnavailableReason(activeProvider) && activeProvider.byok.hasKey();

  return (
    <div className="ai-model">
      <button
        type="button"
        className="ai-model__btn"
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="menu"
        aria-expanded={open}
        title="Model for AI assists"
      >
        <span className="ai-model__dot" data-ready={activeReady ? '' : undefined} />
        <span className="ai-model__label">{activeLabel}</span>
        <span aria-hidden className="ai-model__chev">
          ▾
        </span>
      </button>

      {open ? (
        <>
          <div className="ai-model__backdrop" onMouseDown={() => setOpen(false)} />
          <div className="ai-model__menu" role="menu">
            {PROVIDER_LIST.map((def) => {
              const unavailableReason = providerUnavailableReason(def);
              const hasKey = !unavailableReason && def.byok.hasKey();
              return (
                <div key={def.id} className="ai-model__group">
                  <div className="ai-model__grouphead">
                    <span>{def.label}</span>
                    {!unavailableReason && !hasKey ? (
                      <button
                        type="button"
                        className="ai-model__setkey"
                        onClick={() => {
                          setOpen(false);
                          openSettings();
                        }}
                      >
                        Set key →
                      </button>
                    ) : null}
                  </div>
                  {unavailableReason ? (
                    <p className="ai-model__locked">{unavailableReason}</p>
                  ) : hasKey ? (
                    def.models.map((m) => (
                      <button
                        key={m.id}
                        type="button"
                        className="ai-model__item"
                        role="menuitem"
                        data-active={def.id === providerId && m.id === modelId ? '' : undefined}
                        onClick={() => {
                          setProvider(def.id);
                          setModel(m.id);
                          setOpen(false);
                        }}
                      >
                        {m.label}
                      </button>
                    ))
                  ) : (
                    <p className="ai-model__locked">Add a key to use {def.label}.</p>
                  )}
                </div>
              );
            })}
          </div>
        </>
      ) : null}
    </div>
  );
}

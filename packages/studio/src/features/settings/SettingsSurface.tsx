/**
 * Settings — global configuration and sandbox maintenance (shell spec N2).
 *
 * The Sandbox card teaches VISUALLY, not with prose: its first row shows what
 * the sandbox IS right now (instance + live inventory + persistence — the
 * counts come from the same resource index the Home typeahead builds, no new
 * counting ops), and each action carries a one-line consequence plus a small
 * directional glyph (state→file, file→state, fork, loop-back). Reset shows
 * its cost by restating the live inventory in an inline two-step confirm (no
 * modal). Saved states list under the actions; their empty state is the teacher.
 */

import { useEffect, useRef, useState, type ChangeEvent, type ReactNode } from 'react';
import './settings.css';
import { instanceSlug } from '../../shell/instance-slug.js';
import { useServeInit } from '../../shell/serve-init.js';
import {
  useSandboxInstanceId,
  useSavedStates,
  useStudioExport,
  useStudioImport,
} from '../../shell/studio-saved-states.js';
import { useStudioReset } from '../../shell/studio-writes.js';
import { useResourceIndex } from '../home/useResourceIndex.js';
import { countInventory, inventoryLine } from './sandbox-inventory.js';

// ─── Action glyphs: simple line SVGs, one weight, currentColor ──────────────

function glyphProps() {
  return {
    width: 15,
    height: 15,
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.7,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
    'aria-hidden': true as const,
  };
}

/** State → file: arrow leaving into a tray. */
function GlyphExport() {
  return (
    <svg {...glyphProps()}>
      <path d="M12 4v10" />
      <path d="M8 10l4 4 4-4" />
      <path d="M4 19h16" />
    </svg>
  );
}

/** File → state: arrow rising from the tray into the box. */
function GlyphImport() {
  return (
    <svg {...glyphProps()}>
      <path d="M12 14V4" />
      <path d="M8 8l4-4 4 4" />
      <path d="M4 19h16" />
    </svg>
  );
}

/** A saved state: the current line keeps going; a copy is kept aside. */
function GlyphSavedState() {
  return (
    <svg {...glyphProps()}>
      <circle cx="7" cy="6" r="2.4" />
      <circle cx="7" cy="18" r="2.4" />
      <circle cx="17" cy="8" r="2.4" />
      <path d="M7 8.4v7.2" />
      <path d="M17 10.4c0 3-4 3.6-7 4.4" />
    </svg>
  );
}

/** Loop-back: everything returns to the start. */
function GlyphReset() {
  return (
    <svg {...glyphProps()}>
      <path d="M4 5v5h5" />
      <path d="M4.6 10a8 8 0 1 0 1.7-5.3" />
    </svg>
  );
}

// ─── One action tile: name + consequence caption + directional glyph ────────

function ActionTile({
  glyph,
  name,
  caption,
  disabled,
  danger,
  onClick,
}: {
  glyph: ReactNode;
  name: string;
  caption: string;
  disabled?: boolean;
  danger?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className="studio-sandbox__action"
      data-danger={danger ? 'true' : undefined}
      disabled={disabled}
      onClick={onClick}
    >
      <span className="studio-sandbox__action-top">
        {glyph}
        <span className="studio-sandbox__action-name">{name}</span>
      </span>
      <span className="studio-sandbox__action-caption">{caption}</span>
    </button>
  );
}

// ─── The surface ─────────────────────────────────────────────────────────────

export function SettingsSurface() {
  const reset = useStudioReset();
  const exportState = useStudioExport();
  const importState = useStudioImport();
  const savedStates = useSavedStates();
  const serve = useServeInit();
  const fileRef = useRef<HTMLInputElement>(null);
  const slug = instanceSlug(useSandboxInstanceId());
  const [resetting, setResetting] = useState(false);
  const [importing, setImporting] = useState(false);
  const [confirmingReset, setConfirmingReset] = useState(false);
  const [namingState, setNamingState] = useState(false);
  const [stateName, setStateName] = useState('');

  // The live inventory — the same index the Home typeahead builds (no new
  // backend ops). One build on mount is enough for a settings visit; `ensure`
  // rebuilds every call now (see `useResourceIndex`), but its identity is
  // stable across a build's lifetime, so this effect fires once on mount and
  // not again per keystroke or rebuild elsewhere.
  const index = useResourceIndex();
  const { ensure } = index;
  useEffect(() => ensure(), [ensure]);
  const counts = countInventory(index.entries);
  const inventory = inventoryLine(counts);

  const persistence =
    serve.status === 'ready'
      ? serve.payload.persist
        ? 'persisted to disk'
        : 'ephemeral'
      : 'in-page · resets on reload';

  const onExport = async () => {
    const bundle = await exportState();
    if (!bundle || typeof document === 'undefined') return;
    const url = URL.createObjectURL(new Blob([bundle], { type: 'application/json' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = `pyric-sandbox-${slug || 'export'}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const onImportFile = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    if (
      typeof window !== 'undefined' &&
      !window.confirm('Import replaces all data in this sandbox. This cannot be undone. Continue?')
    ) {
      return;
    }
    setImporting(true);
    try {
      await importState(await file.text());
    } finally {
      setImporting(false);
    }
  };

  const onReset = async () => {
    setConfirmingReset(false);
    setResetting(true);
    try {
      await reset();
    } finally {
      setResetting(false);
    }
  };

  const onSaveState = async () => {
    const name = stateName.trim();
    if (!name) return;
    await savedStates.save(name);
    setStateName('');
    setNamingState(false);
  };

  const onRestoreState = async (name: string) => {
    if (
      typeof window !== 'undefined' &&
      !window.confirm(`Restore saved state "${name}"? This replaces the current sandbox state.`)
    ) {
      return;
    }
    await savedStates.restore(name);
  };

  const onDeleteState = async (name: string) => {
    if (typeof window !== 'undefined' && !window.confirm(`Delete saved state "${name}"?`)) return;
    await savedStates.remove(name);
  };

  return (
    <section className="studio-surface studio-settings" aria-labelledby="settings-title">
      <div className="studio-surface__intro">
        <p className="studio-surface__eyebrow">Settings</p>
        <h1 id="settings-title" className="studio-surface__title">
          Configuration and maintenance.
        </h1>
        <p className="studio-surface__copy">
          Global controls live here so service surfaces can stay focused on their
          primary work.
        </p>
      </div>

      <div className="studio-settings__grid">
        <section className="studio-panel studio-settings__panel" aria-labelledby="settings-sandbox-title">
          <h2 id="settings-sandbox-title" className="studio-panel__title">
            Sandbox
          </h2>

          {/* Row 1 — what the sandbox IS right now. Every action below
              visibly operates on this. */}
          <div className="studio-sandbox__live" aria-label="Sandbox contents">
            <span className="studio-sandbox__instance mono">{slug || 'local'}</span>
            <span className="studio-sandbox__inventory">{inventory}</span>
            <span className="studio-sandbox__persist">{persistence}</span>
          </div>

          <div className="studio-sandbox__actions">
            <ActionTile
              glyph={<GlyphExport />}
              name="Export"
              caption="Downloads all of this as one file."
              onClick={() => void onExport()}
            />
            <ActionTile
              glyph={<GlyphImport />}
              name={importing ? 'Importing…' : 'Import'}
              caption="A chosen file replaces everything here."
              disabled={importing}
              onClick={() => fileRef.current?.click()}
            />
            <ActionTile
              glyph={<GlyphSavedState />}
              name="Save state"
              caption="Keeps a copy you can return to."
              onClick={() => setNamingState((v) => !v)}
            />
            <ActionTile
              glyph={<GlyphReset />}
              name={resetting ? 'Resetting…' : 'Reset session'}
              caption="Everything returns to the seeded start."
              disabled={resetting}
              danger
              onClick={() => setConfirmingReset(true)}
            />
          </div>
          <input
            ref={fileRef}
            type="file"
            accept="application/json,.json"
            className="studio-settings__file"
            onChange={onImportFile}
          />

          {/* Transient: name the saved state inline (no prompt dialog). */}
          {namingState ? (
            <form
              className="studio-sandbox__name-row"
              onSubmit={(e) => {
                e.preventDefault();
                void onSaveState();
              }}
            >
              <input
                className="studio-sandbox__name-input"
                type="text"
                value={stateName}
                placeholder="saved state name"
                aria-label="Saved state name"
                autoFocus
                onChange={(e) => setStateName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Escape') {
                    setNamingState(false);
                    setStateName('');
                  }
                }}
              />
              <button type="submit" className="studio-button" disabled={!stateName.trim()}>
                Save
              </button>
              <button
                type="button"
                className="studio-button"
                onClick={() => {
                  setNamingState(false);
                  setStateName('');
                }}
              >
                Cancel
              </button>
            </form>
          ) : null}

          {/* Transient: reset confirms inline, restating the live inventory —
              the cost made concrete. */}
          {confirmingReset ? (
            <div className="studio-sandbox__confirm" role="alert">
              <span className="studio-sandbox__confirm-copy">
                {counts && inventory !== 'empty — no data yet'
                  ? `This erases ${inventory}.`
                  : 'This erases everything in this sandbox.'}
              </span>
              <span className="studio-sandbox__confirm-actions">
                <button
                  type="button"
                  className="studio-button studio-button--danger"
                  onClick={() => void onReset()}
                >
                  Erase and reseed
                </button>
                <button
                  type="button"
                  className="studio-button"
                  onClick={() => setConfirmingReset(false)}
                >
                  Keep
                </button>
              </span>
            </div>
          ) : null}

          {/* Secondary tier: saved states. The empty state teaches what
              "Save state" is for. */}
          {savedStates.names.length > 0 ? (
            <div className="studio-settings__saved-states">
              {savedStates.names.map((name) => (
                <div key={name} className="studio-settings__saved-state">
                  <span className="mono">{name}</span>
                  <span className="studio-settings__saved-state-actions">
                    <button type="button" className="studio-button" onClick={() => void onRestoreState(name)}>
                      Restore
                    </button>
                    <button type="button" className="studio-button" onClick={() => void onDeleteState(name)}>
                      Delete
                    </button>
                  </span>
                </div>
              ))}
            </div>
          ) : (
            <p className="studio-sandbox__saved-states-empty">
              No saved states yet. Save state keeps this exact sandbox to come back to.
            </p>
          )}
        </section>
      </div>
    </section>
  );
}

/**
 * Settings — global configuration and sandbox maintenance (shell spec N2).
 *
 * The Sandbox card teaches VISUALLY, not with prose: its first row shows what
 * the sandbox IS right now (instance + live inventory + persistence — the
 * counts come from the same resource index the Home typeahead builds, no new
 * counting ops), and each action carries a one-line consequence plus a small
 * directional glyph (state→file, file→state, fork, loop-back). Reset shows
 * its cost by restating the live inventory in an inline two-step confirm (no
 * modal). Branches list under the actions; their empty state is the teacher.
 */

import { useEffect, useRef, useState, type ChangeEvent, type ReactNode } from 'react';
import { instanceSlug } from '../../shell/instance-slug.js';
import { useServeInit } from '../../shell/serve-init.js';
import {
  useSandboxInstanceId,
  useStudioBranches,
  useStudioExport,
  useStudioImport,
  useStudioReset,
} from '../../shell/studio-data.js';
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

/** Fork: the current line keeps going; a copy branches off. */
function GlyphBranch() {
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
  const branches = useStudioBranches();
  const serve = useServeInit();
  const fileRef = useRef<HTMLInputElement>(null);
  const slug = instanceSlug(useSandboxInstanceId());
  const [resetting, setResetting] = useState(false);
  const [importing, setImporting] = useState(false);
  const [confirmingReset, setConfirmingReset] = useState(false);
  const [namingBranch, setNamingBranch] = useState(false);
  const [branchName, setBranchName] = useState('');

  // The live inventory — the same index the Home typeahead builds (30s TTL,
  // no new backend ops). One build on mount is enough for a settings visit.
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

  const onSaveBranch = async () => {
    const name = branchName.trim();
    if (!name) return;
    await branches.save(name);
    setBranchName('');
    setNamingBranch(false);
  };

  const onSwitchBranch = async (name: string) => {
    if (
      typeof window !== 'undefined' &&
      !window.confirm(`Switch to branch "${name}"? This replaces the current sandbox state.`)
    ) {
      return;
    }
    await branches.switchTo(name);
  };

  const onDeleteBranch = async (name: string) => {
    if (typeof window !== 'undefined' && !window.confirm(`Delete branch "${name}"?`)) return;
    await branches.remove(name);
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
              glyph={<GlyphBranch />}
              name="Save branch"
              caption="Keeps a copy you can return to."
              onClick={() => setNamingBranch((v) => !v)}
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

          {/* Transient: name the branch inline (no prompt dialog). */}
          {namingBranch ? (
            <form
              className="studio-sandbox__name-row"
              onSubmit={(e) => {
                e.preventDefault();
                void onSaveBranch();
              }}
            >
              <input
                className="studio-sandbox__name-input"
                type="text"
                value={branchName}
                placeholder="branch name"
                aria-label="Branch name"
                autoFocus
                onChange={(e) => setBranchName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Escape') {
                    setNamingBranch(false);
                    setBranchName('');
                  }
                }}
              />
              <button type="submit" className="studio-button" disabled={!branchName.trim()}>
                Save
              </button>
              <button
                type="button"
                className="studio-button"
                onClick={() => {
                  setNamingBranch(false);
                  setBranchName('');
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

          {/* Secondary tier: saved branches. The empty state teaches what
              "Save branch" is for. */}
          {branches.branches.length > 0 ? (
            <div className="studio-settings__branches">
              {branches.branches.map((name) => (
                <div key={name} className="studio-settings__branch">
                  <span className="mono">{name}</span>
                  <span className="studio-settings__branch-actions">
                    <button type="button" className="studio-button" onClick={() => void onSwitchBranch(name)}>
                      Switch
                    </button>
                    <button type="button" className="studio-button" onClick={() => void onDeleteBranch(name)}>
                      Delete
                    </button>
                  </span>
                </div>
              ))}
            </div>
          ) : (
            <p className="studio-sandbox__branches-empty">
              No branches yet — Save branch keeps this exact state to come back to.
            </p>
          )}
        </section>
      </div>
    </section>
  );
}

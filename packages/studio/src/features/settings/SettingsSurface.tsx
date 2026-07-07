import { useRef, useState, type ChangeEvent } from 'react';
import { instanceSlug } from '../../shell/instance-slug.js';
import {
  useSandboxInstanceId,
  useStudioBranches,
  useStudioExport,
  useStudioImport,
  useStudioReset,
} from '../../shell/studio-data.js';

export function SettingsSurface() {
  const reset = useStudioReset();
  const exportState = useStudioExport();
  const importState = useStudioImport();
  const branches = useStudioBranches();
  const fileRef = useRef<HTMLInputElement>(null);
  const slug = instanceSlug(useSandboxInstanceId());
  const [resetting, setResetting] = useState(false);
  const [importing, setImporting] = useState(false);

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
    if (
      typeof window !== 'undefined' &&
      !window.confirm('Reset this sandbox session? This clears current sandbox state.')
    ) {
      return;
    }
    setResetting(true);
    try {
      await reset();
    } finally {
      setResetting(false);
    }
  };

  const onSaveBranch = async () => {
    const name =
      typeof window !== 'undefined'
        ? window.prompt('Save current sandbox as a branch named:')?.trim()
        : '';
    if (name) await branches.save(name);
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
          <p className="studio-settings__muted">
            Instance <span className="mono">{slug || 'local'}</span>
          </p>
          <div className="studio-settings__actions">
            <button type="button" className="studio-button" onClick={onExport}>
              Export
            </button>
            <button
              type="button"
              className="studio-button"
              disabled={importing}
              onClick={() => fileRef.current?.click()}
            >
              {importing ? 'Importing...' : 'Import'}
            </button>
            <input
              ref={fileRef}
              type="file"
              accept="application/json,.json"
              className="studio-settings__file"
              onChange={onImportFile}
            />
            <button type="button" className="studio-button" onClick={onSaveBranch}>
              Save branch
            </button>
            <button
              type="button"
              className="studio-button studio-button--danger"
              disabled={resetting}
              onClick={() => void onReset()}
            >
              {resetting ? 'Resetting...' : 'Reset session'}
            </button>
          </div>

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
          ) : null}
        </section>
      </div>
    </section>
  );
}

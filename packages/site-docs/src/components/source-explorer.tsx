import { useState } from 'react';

export interface SourceFile {
  id: string;
  label: string;
  source: string;
}

interface Props {
  files: SourceFile[];
  label: string;
}

export function SourceExplorer({ files, label }: Props) {
  const [selected, setSelected] = useState(files[0]?.id ?? '');
  const [copied, setCopied] = useState(false);
  const active = files.find((file) => file.id === selected) ?? files[0];

  const copy = async () => {
    if (!active) return;
    await navigator.clipboard.writeText(active.source);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1500);
  };

  return (
    <section className="source-explorer" aria-label={label}>
      <div className="source-toolbar">
        {files.length === 1 ? <strong>{active?.label}</strong> : (
          <div className="source-tabs" role="tablist" aria-label="Source files">
            {files.map((file) => (
            <button
              type="button"
              role="tab"
              aria-selected={active?.id === file.id}
              key={file.id}
              onClick={() => setSelected(file.id)}
            >{file.label}</button>
            ))}
          </div>
        )}
        <button type="button" className="copy-source" onClick={copy}>{copied ? 'Copied' : 'Copy source'}</button>
      </div>
      <pre role={files.length > 1 ? 'tabpanel' : undefined}><code>{active?.source ?? ''}</code></pre>
    </section>
  );
}

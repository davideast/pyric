import { useState } from 'react';
import { DocumentPreview } from '@pyric/ui/firestore';
import { CopyButton, useToast } from '@pyric/ui/primitives';
import { makeSnapshot, RICH_USER } from './fixtures';

const FIXTURE_PATH = 'users/alice';

export function DocumentPreviewShowcase() {
  const { toast } = useToast();
  const [lastClicked, setLastClicked] = useState<string | null>(null);

  return (
    <div className="space-y-6">
      <div>
        <div className="text-[12px] text-muted-gray mb-1.5">
          With <code className="font-mono text-soft-gray">onReferenceClick</code> wired —
          the <code className="font-mono text-soft-gray">manager</code> field is
          clickable.
        </div>
        {/* The library is headless and intentionally does not render
            a doc-id header — that's a consumer composition choice.
            This is a common pattern: render the path above the
            preview with a copy button, then mount the component. */}
        <div className="flex items-center gap-2 mb-1.5 text-[12px]">
          <span className="text-muted-gray">path</span>
          <span className="font-mono text-soft-white">{FIXTURE_PATH}</span>
          <CopyButton text={FIXTURE_PATH} className="showcase-copy-btn !py-0.5 !px-2 !text-[11px]">
            Copy path
          </CopyButton>
        </div>
        <DocumentPreview
          snapshot={makeSnapshot('alice', RICH_USER)}
          onReferenceClick={(ref) => {
            setLastClicked(ref.path);
            toast({ title: 'Reference clicked', body: ref.path, kind: 'info' });
          }}
        />
      </div>

      <div className="text-[12px] text-muted-gray">
        last reference click: <span className="font-mono text-soft-gray">{lastClicked ?? '—'}</span>
      </div>

      <div>
        <div className="text-[12px] text-muted-gray mb-1.5">Empty state.</div>
        <DocumentPreview
          snapshot={makeSnapshot('ghost', null)}
          emptyState={
            <div className="rounded-lg border border-dashed border-border-soft bg-panel-bg p-4 text-muted-gray text-[13px] italic">
              No such document.
            </div>
          }
        />
      </div>

      <pre className="bg-panel-bg border border-border-soft rounded p-3 text-[12px] font-mono text-soft-gray overflow-x-auto">{`<DocumentPreview
  snapshot={snap}
  onReferenceClick={(ref) => navigate(ref.path)}
/>`}</pre>
    </div>
  );
}

import { useState } from 'react';
import { useConfirm } from '@pyric/ui/primitives';

export function ConfirmDialogShowcase() {
  const confirm = useConfirm();
  const [last, setLast] = useState<string>('—');

  async function askNormal() {
    const ok = await confirm({
      title: 'Apply changes?',
      body: 'The document will be saved with your latest edits.',
      confirmLabel: 'Apply',
    });
    setLast(ok ? 'confirmed' : 'cancelled');
  }

  async function askDestructive() {
    const ok = await confirm({
      title: 'Delete users/alice?',
      body: 'This document and all its subcollections will be removed. This cannot be undone.',
      destructive: true,
      confirmLabel: 'Delete',
    });
    setLast(ok ? 'confirmed (destructive)' : 'cancelled');
  }

  return (
    <div className="space-y-6">
      <div className="flex gap-3">
        <button onClick={askNormal} className="showcase-copy-btn">
          Ask (normal)
        </button>
        <button onClick={askDestructive} className="showcase-copy-btn">
          Ask (destructive)
        </button>
      </div>
      <div className="text-[12px] text-muted-gray">
        last result: <span className="font-mono text-soft-gray">{last}</span>
      </div>
      <pre className="bg-panel-bg border border-border-soft rounded p-3 text-[12px] font-mono text-soft-gray overflow-x-auto">{`const confirm = useConfirm();
const ok = await confirm({
  title: 'Delete users/alice?',
  body: 'This cannot be undone.',
  destructive: true,
});`}</pre>
    </div>
  );
}

import { useState } from 'react';
import {
  DocumentEditor,
  type UseDocumentEditorResult,
} from '@pyric/ui/firestore';
import { useToast } from '@pyric/ui/primitives';
import { RICH_USER } from './fixtures';

export function DocumentEditorShowcase() {
  const [editor, setEditor] = useState<UseDocumentEditorResult | null>(null);
  const { toast } = useToast();

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <button
          className="showcase-copy-btn"
          disabled={!editor?.isDirty || !editor.isValid}
          onClick={() => {
            if (!editor) return;
            toast({
              title: 'Document saved (simulated)',
              body: JSON.stringify(editor.toData()).slice(0, 80) + '…',
              kind: 'success',
            });
          }}
        >
          Save
        </button>
        <button
          className="showcase-copy-btn"
          disabled={!editor?.isDirty}
          onClick={() => editor?.reset()}
        >
          Reset
        </button>
        <div className="text-[12px] text-muted-gray ml-auto">
          {editor ? (
            <>
              <Badge>{editor.isValid ? 'valid' : 'invalid'}</Badge>
              <span className="mx-2">·</span>
              <Badge>{editor.isDirty ? 'dirty' : 'clean'}</Badge>
              <span className="mx-2">·</span>
              <span className="font-mono text-soft-gray">
                {editor.errorCount} error{editor.errorCount === 1 ? '' : 's'}
              </span>
            </>
          ) : null}
        </div>
      </div>

      <DocumentEditor.Root initial={RICH_USER} onChange={setEditor}>
        <DocumentEditor.Fields />
      </DocumentEditor.Root>

      <pre className="bg-panel-bg border border-border-soft rounded p-3 text-[12px] font-mono text-soft-gray overflow-x-auto">{`<DocumentEditor.Root initial={data} onChange={setEditor}>
  <DocumentEditor.Fields />
</DocumentEditor.Root>

<button
  disabled={!editor.isValid || !editor.isDirty}
  onClick={() => setDoc(ref, editor.toData())}
>
  Save
</button>`}</pre>
    </div>
  );
}

function Badge({ children }: { children: React.ReactNode }) {
  return (
    <span className="font-mono text-[11px] uppercase tracking-wider text-soft-gray">
      {children}
    </span>
  );
}

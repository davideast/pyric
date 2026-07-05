import { useState } from 'react';
import { ReferencePicker } from '@pyric/ui/firestore';
import { useToast } from '@pyric/ui/primitives';
import type { CollectionReference, DocumentReference, Firestore } from 'pyric/firestore';
import { firestore, makeColl } from './fixtures';

// Mock collection listing for the picker. Real consumers wire
// `@pyric/sandbox` introspection (dev) or a server proxy / schema
// (prod); the showcase fakes a two-level tree so we can demo
// drill-in without writing any real data.
const SUBCOLLS: Record<string, string[]> = {
  __root__: ['users', 'posts', 'orders'],
  'users/alice': ['sessions', 'audit'],
  'users/bob': ['sessions'],
  'posts/post-1': ['comments'],
};

async function listCollections(
  _fs: Firestore,
  parent: DocumentReference | null,
): Promise<CollectionReference[]> {
  const key = parent ? parent.path : '__root__';
  const ids = SUBCOLLS[key] ?? [];
  return ids.map((id) => makeColl(parent ? `${parent.path}/${id}` : id));
}

export function ReferencePickerShowcase() {
  const { toast } = useToast();
  const [picked, setPicked] = useState<string | null>(null);

  return (
    <div className="space-y-6">
      <ReferencePicker
        firestore={firestore}
        listCollections={listCollections}
        onPick={(ref) => {
          setPicked(ref.path);
          toast({ title: 'Reference picked', body: ref.path, kind: 'success' });
        }}
      />

      <div className="text-[12px] text-muted-gray">
        last pick: <span className="font-mono text-soft-gray">{picked ?? '—'}</span>
      </div>

      <div className="text-[12px] text-muted-gray space-y-1">
        <div>Try: type <code className="font-mono text-soft-gray">users/alice</code> → Commit.</div>
        <div>
          Or: <strong>Browse</strong> → click <code className="font-mono text-soft-gray">users/</code>.
          The collection's docs come back empty (no real data here) — drilling demonstrates the
          panel transition.
        </div>
      </div>

      <pre className="bg-panel-bg border border-border-soft rounded p-3 text-[12px] font-mono text-soft-gray overflow-x-auto">{`<ReferencePicker
  firestore={fs}
  listCollections={mySchemaAwareLister}
  onPick={(ref) => editor.setValue(nodeId, ref)}
/>`}</pre>
    </div>
  );
}

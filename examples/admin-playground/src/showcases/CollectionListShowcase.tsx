import { useState } from 'react';
import { CollectionList } from '@pyric/ui/firestore';
import type { CollectionReference } from 'pyric/firestore';
import { useToast } from '@pyric/ui/primitives';
import { FIXTURE_COLLECTIONS } from './fixtures';

export function CollectionListShowcase() {
  const { toast } = useToast();
  const [picked, setPicked] = useState<string | null>(null);

  return (
    <div className="space-y-6">
      <div>
        <div className="text-[12px] text-muted-gray mb-1.5">Populated.</div>
        <CollectionList
          collections={FIXTURE_COLLECTIONS}
          onSelect={(coll: CollectionReference) => {
            setPicked(coll.id);
            toast({ title: 'Selected collection', body: coll.path, kind: 'info' });
          }}
        />
      </div>

      <div className="text-[12px] text-muted-gray">
        last pick: <span className="font-mono text-soft-gray">{picked ?? '—'}</span>
      </div>

      <div>
        <div className="text-[12px] text-muted-gray mb-1.5">Empty.</div>
        <CollectionList
          collections={[]}
          emptyState={<>No collections under this parent.</>}
        />
      </div>

      <div>
        <div className="text-[12px] text-muted-gray mb-1.5">Loading.</div>
        <CollectionList collections={[]} isLoading />
      </div>

      <div>
        <div className="text-[12px] text-muted-gray mb-1.5">Error.</div>
        <CollectionList
          collections={[]}
          error={new Error('permission-denied: list requires owner role')}
        />
      </div>

      <pre className="bg-panel-bg border border-border-soft rounded p-3 text-[12px] font-mono text-soft-gray overflow-x-auto">{`const { collections, isLoading, error } = useCollectionList({
  firestore, parent, listCollections,
});

<CollectionList
  collections={collections}
  isLoading={isLoading}
  error={error}
  onSelect={(coll) => navigate(coll.path)}
/>`}</pre>
    </div>
  );
}

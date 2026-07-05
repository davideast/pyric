import { useState } from 'react';
import { DocumentList } from '@pyric/ui/firestore';
import { useToast } from '@pyric/ui/primitives';
import { FIXTURE_USERS } from './fixtures';

export function DocumentListShowcase() {
  const { toast } = useToast();
  const [pickedPath, setPickedPath] = useState<string | null>(null);

  return (
    <div className="space-y-6">
      <div>
        <div className="text-[12px] text-muted-gray mb-1.5">
          Default — row label is the doc id.
        </div>
        <DocumentList
          documents={FIXTURE_USERS}
          onSelect={(ref) => {
            setPickedPath(ref.path);
            toast({ title: 'Selected document', body: ref.path, kind: 'info' });
          }}
        />
      </div>

      <div>
        <div className="text-[12px] text-muted-gray mb-1.5">
          With <code className="font-mono text-soft-gray">renderLabel</code> showing a
          summary field.
        </div>
        <DocumentList
          documents={FIXTURE_USERS}
          onSelect={(ref) => setPickedPath(ref.path)}
          renderLabel={(doc) => (
            <span className="flex items-center justify-between gap-3">
              <span>{(doc.data() as { name: string }).name}</span>
              <span className="text-muted-gray text-[11px] font-mono">{doc.id}</span>
            </span>
          )}
        />
      </div>

      <div>
        <div className="text-[12px] text-muted-gray mb-1.5">
          With Load More (simulated <code className="font-mono text-soft-gray">hasMore</code>).
        </div>
        <DocumentList
          documents={FIXTURE_USERS.slice(0, 3)}
          hasMore
          onLoadMore={() =>
            toast({
              title: 'loadMore() called',
              body: 'Wire the hook to actually fetch the next page.',
            })
          }
        />
      </div>

      <div className="text-[12px] text-muted-gray">
        last pick: <span className="font-mono text-soft-gray">{pickedPath ?? '—'}</span>
      </div>

      <pre className="bg-panel-bg border border-border-soft rounded p-3 text-[12px] font-mono text-soft-gray overflow-x-auto">{`const { documents, hasMore, loadMore, isLoading } =
  useDocumentList({ collection, pageSize: 50 });

<DocumentList
  documents={documents}
  isLoading={isLoading}
  hasMore={hasMore}
  onLoadMore={loadMore}
  onSelect={(ref) => navigate(ref.path)}
/>`}</pre>
    </div>
  );
}

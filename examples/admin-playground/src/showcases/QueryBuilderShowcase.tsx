import { useState } from 'react';
import { QueryBuilder, type UseQueryBuilderResult } from '@pyric/ui/firestore';

export function QueryBuilderShowcase() {
  const [builder, setBuilder] = useState<UseQueryBuilderResult | null>(null);

  return (
    <div className="space-y-6">
      <QueryBuilder
        initial={{
          conditions: [
            { id: 'c1', field: 'active', op: '==', value: true },
          ],
          orderBy: { field: 'score', direction: 'desc' },
          limit: 20,
        }}
        onChange={setBuilder}
      />

      <div className="text-[12px] text-muted-gray">
        Values are JSON-parsed: try <code className="font-mono text-soft-gray">true</code>,{' '}
        <code className="font-mono text-soft-gray">42</code>, or{' '}
        <code className="font-mono text-soft-gray">["a", "b"]</code> for an{' '}
        <code className="font-mono text-soft-gray">in</code> operator.
      </div>

      <div>
        <div className="text-[12px] text-muted-gray mb-1.5">
          Current state — what <code className="font-mono text-soft-gray">buildQuery</code>{' '}
          would compose:
        </div>
        <pre className="bg-panel-bg border border-border-soft rounded p-3 text-[12px] font-mono text-soft-gray overflow-x-auto">
{JSON.stringify(
  {
    conditions: builder?.conditions ?? [],
    orderBy: builder?.orderBy,
    limit: builder?.limit,
  },
  null,
  2,
)}
        </pre>
      </div>

      <pre className="bg-panel-bg border border-border-soft rounded p-3 text-[12px] font-mono text-soft-gray overflow-x-auto">{`const [builder, setBuilder] = useState(null);

<QueryBuilder onChange={setBuilder} />

// Compose into a real Firestore query:
const q = builder?.buildQuery(collection(firestore, 'users'));
const { documents } = useDocumentList({ collection, query: q });`}</pre>
    </div>
  );
}

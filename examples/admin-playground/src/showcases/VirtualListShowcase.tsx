import { useState } from 'react';
import { VirtualList } from '@pyric/ui/primitives';

interface Row {
  id: string;
  name: string;
  score: number;
}

const ROWS: Row[] = Array.from({ length: 10_000 }, (_, i) => ({
  id: `row-${i}`,
  name: `Row ${i}`,
  score: Math.floor(Math.random() * 1_000_000),
}));

export function VirtualListShowcase() {
  const [picked, setPicked] = useState<string | null>(null);

  return (
    <div className="space-y-6">
      <div className="text-[12px] text-muted-gray">
        10,000 rows. Only the rows in view (plus a few overscan
        neighbors) are mounted to the DOM. Scroll fast — the row
        count in DevTools stays small.
      </div>

      <div className="rounded-lg border border-border-soft bg-panel-bg overflow-hidden">
        <VirtualList<Row>
          items={ROWS}
          estimateSize={36}
          height={480}
          getItemKey={(row) => row.id}
          renderItem={(row, i) => (
            <button
              type="button"
              onClick={() => setPicked(row.id)}
              className={[
                'block w-full text-left px-4 py-2 text-[13px] font-mono',
                'hover:bg-canvas-bg/60 transition-colors',
                i % 2 === 0 ? 'bg-transparent' : 'bg-canvas-bg/30',
              ].join(' ')}
            >
              <span className="text-soft-white">{row.name}</span>
              <span className="text-muted-gray float-right">{row.score.toLocaleString()}</span>
            </button>
          )}
        />
      </div>

      <div className="text-[12px] text-muted-gray">
        last pick: <span className="font-mono text-soft-gray">{picked ?? '—'}</span>
      </div>

      <pre className="bg-panel-bg border border-border-soft rounded p-3 text-[12px] font-mono text-soft-gray overflow-x-auto">{`<VirtualList<Row>
  items={rows}
  estimateSize={36}
  height={480}
  getItemKey={(row) => row.id}
  renderItem={(row, i) => <Row data={row} />}
/>`}</pre>
    </div>
  );
}

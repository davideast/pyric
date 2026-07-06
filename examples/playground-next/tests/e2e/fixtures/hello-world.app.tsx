/**
 * Fixture appSource for the deploy proof. Three deliberate
 * characteristics:
 *
 *   1. Canonical `firebase/firestore` imports — exercises the
 *      bundler path without aliases (deploy build, not sandbox
 *      preview). The metafile gate should pass since this file
 *      references zero `@pyric/*` modules.
 *   2. `query(... where ... orderBy ...)` — forces the index
 *      analyzer to emit one composite index, giving the
 *      `indexes.create` deploy step real work and a real LRO to
 *      poll. Without this, indexes would deploy "no indexes
 *      inferred" and we wouldn't exercise the LRO path.
 *   3. `data-testid="proof-rows"` — stable selector for the
 *      live-URL assertion. The test asserts the rendered count
 *      matches the seeded document count.
 *
 * Loaded as a string by the test, fed into the workspace store
 * via `window.__pyricTestSeed({ appSource: <this file's text> })`.
 * The playground's deploy hook then bundles it through esbuild-wasm
 * with the template wrapper and ships to Firebase Hosting.
 */
import * as React from 'react';
import { collection, getDocs, orderBy, query, where } from 'firebase/firestore';
import { db } from './firebase';

interface ProofRow {
  label: string;
  active: boolean;
}

export default function App() {
  const [rows, setRows] = React.useState<ProofRow[]>([]);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    const q = query(
      collection(db, 'proof'),
      where('active', '==', true),
      orderBy('createdAt', 'desc'),
    );
    getDocs(q)
      .then((snap) => {
        setRows(snap.docs.map((d) => d.data() as ProofRow));
      })
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, []);

  if (error) {
    return (
      <div data-testid="proof-error" style={{ padding: 16, fontFamily: 'monospace' }}>
        error: {error}
      </div>
    );
  }

  return (
    <div data-testid="proof-rows" style={{ padding: 16, fontFamily: 'monospace' }}>
      {rows.length} proof row{rows.length === 1 ? '' : 's'}
    </div>
  );
}

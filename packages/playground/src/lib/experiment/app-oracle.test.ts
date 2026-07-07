/** App-oracle (W0) — the dimension vector must catch exactly the failure
 *  classes the rules-only oracle was blind to. Bun-only, like the module. */
import { describe, expect, test } from 'bun:test';
import { scoreApp } from './app-oracle';

const APP = '/workspace/src/App.tsx';

const MINIMAL = `export default function App() {
  return <main><h1>hello</h1></main>;
}
`;

const FIREBASE_APP = `import { useState } from "react";
import { collection, query, where } from "firebase/firestore";
import { getAuth } from "firebase/auth";
import { db } from "./firebase";

export default function App() {
  const [n] = useState(0);
  const q = query(collection(db, "orders"), where("userId", "==", "alice"));
  const auth = getAuth();
  return (
    <main>
      <h1>orders {String(Boolean(q))} {String(Boolean(auth))} {n}</h1>
    </main>
  );
}
`;

describe('app oracle — compile dimension', () => {
  test('valid TSX compiles', async () => {
    const s = await scoreApp({ files: { [APP]: MINIMAL } });
    expect(s.compile.ok).toBe(true);
  });

  test('syntax error fails compile and skips render', async () => {
    const s = await scoreApp({ files: { [APP]: 'export default function App() { return <div>; }' } });
    expect(s.compile.ok).toBe(false);
    expect(s.compile.error).toContain(APP);
    expect(s.render.ok).toBe(false);
  });

  test('missing App.tsx fails both dimensions (the DV blind spot)', async () => {
    const s = await scoreApp({ files: { '/workspace/firestore.rules': 'rules_version = "2";' } });
    expect(s.compile.ok).toBe(false);
    expect(s.compile.error).toContain('no /workspace/src/App.tsx');
    expect(s.render.ok).toBe(false);
  });

  test('a broken sibling module fails compile even when App.tsx is fine', async () => {
    const s = await scoreApp({
      files: { [APP]: MINIMAL, '/workspace/src/util.ts': 'export const x = {{{' },
    });
    expect(s.compile.ok).toBe(false);
    expect(s.compile.error).toContain('util.ts');
  });
});

describe('app oracle — render dimension', () => {
  test('minimal component mounts with markup', async () => {
    const s = await scoreApp({ files: { [APP]: MINIMAL } });
    expect(s.render.ok).toBe(true);
    expect(s.render.htmlBytes).toBeGreaterThan(0);
  });

  test('canonical firebase app (aliased imports + ./firebase db + no-arg getAuth) mounts', async () => {
    const s = await scoreApp({ files: { [APP]: FIREBASE_APP } });
    expect(s.compile.ok).toBe(true);
    expect(s.render.error).toBeUndefined();
    expect(s.render.ok).toBe(true);
  });

  test('component that throws at render fails render but not compile', async () => {
    const s = await scoreApp({
      files: { [APP]: 'export default function App() { throw new Error("boom"); }' },
    });
    expect(s.compile.ok).toBe(true);
    expect(s.render.ok).toBe(false);
    expect(s.render.error).toContain('boom');
  });

  test('no default export fails render with a precise reason', async () => {
    const s = await scoreApp({
      files: { [APP]: 'export function App() { return <div>x</div>; }' },
    });
    expect(s.render.ok).toBe(false);
    expect(s.render.error).toContain('default');
  });

  test('multi-file app with relative imports mounts', async () => {
    const s = await scoreApp({
      files: {
        [APP]: 'import { Btn } from "./Btn";\nexport default function App() { return <Btn />; }',
        '/workspace/src/Btn.tsx': 'export function Btn() { return <button>go</button>; }',
      },
    });
    expect(s.render.ok).toBe(true);
  });
});

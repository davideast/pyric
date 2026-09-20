import { expect, test } from 'bun:test';
import { build } from 'vite';
import { fileURLToPath } from 'node:url';
import { NODE_BUILTIN_RE, NODE_BUILTIN_SHIMS } from '../../src/serve/bundler.js';

test('a tree-shaken browser bundle can subscribe to its local Firestore session store', async () => {
  const source = `
        import { initializeSandbox } from 'pyric/sandbox';
        import { getInternalEnv } from 'pyric/sandbox/internal';
        import { getFirestore, collection, onSnapshot, doc, setDoc } from 'pyric/firestore';
        export async function run() {
          const sandbox = initializeSandbox();
          getInternalEnv(sandbox).seed({ rules: 'rules_version = "2"; service cloud.firestore { match /databases/{db}/documents { match /{path=**} { allow read, write: if true; } } }' });
          const db = getFirestore(sandbox);
          const sizes = [];
          let stop;
          try {
            stop = onSnapshot(collection(db, 'sessions'), snap => sizes.push(snap.size));
            await new Promise(resolve => setTimeout(resolve, 0));
            await setDoc(doc(db, 'sessions/one'), { title: 'Local session' });
            await new Promise(resolve => setTimeout(resolve, 0));
            return sizes;
          } finally { stop?.(); sandbox.dispose(); }
        }`;
  const bundle = await build({
    configFile: false,
    root: fileURLToPath(new URL('../../', import.meta.url)),
    logLevel: 'silent',
    plugins: [
      {
        name: 'browser-session-probe',
        resolveId(id) {
          const isProbe = id.endsWith('/session-probe');
          if (isProbe) return '\0session-probe';
          const builtin = NODE_BUILTIN_RE.exec(id);
          if (builtin) return `\0builtin:${builtin[2]}`;
        },
        load(id) {
          const isProbe = id === '\0session-probe';
          if (isProbe) return source;
          const isBuiltin = id.startsWith('\0builtin:');
          if (isBuiltin) return NODE_BUILTIN_SHIMS[id.slice(9)] ?? '';
        },
      },
    ],
    build: {
      write: false,
      minify: false,
      lib: { entry: 'session-probe', formats: ['iife'], name: 'listenerProbe' },
    },
  });
  const outputs = Array.isArray(bundle) ? bundle : [bundle];
  const first = outputs[0];
  const isMissingBundle = first === undefined || !('output' in first);
  if (isMissingBundle) throw new Error('Expected a browser bundle');
  const chunk = first.output.find((output) => output.type === 'chunk');
  const isMissingChunk = chunk === undefined;
  if (isMissingChunk) throw new Error('Expected the listener probe chunk');
  const run = new Function('process', 'Buffer', `${chunk.code}; return listenerProbe.run();`);
  expect(await run(undefined, undefined)).toEqual([0, 1]);
}, 15_000);

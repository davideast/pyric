import { deleteApp, initializeApp } from 'firebase/app';
import { get, getDatabase, goOffline, goOnline, onDisconnect, ref, set } from 'firebase/database';

const CASES = {
  'update-then-update-other-child': {
    seed: { keep: true },
    steps: (od) => [() => od('').update({ a: 1 }), () => od('').update({ b: 2 })],
  },
  'update-then-update-same-child': {
    seed: { keep: true },
    steps: (od) => [() => od('').update({ a: 1 }), () => od('').update({ a: 2 })],
  },
  'update-then-update-deep-keys': {
    seed: { keep: true },
    steps: (od) => [
      () => od('').update({ 'i1/state': 'gone' }),
      () => od('').update({ 'i2/state': 'gone' }),
    ],
  },
  'update-then-update-at-child-path': {
    seed: { keep: true },
    steps: (od) => [() => od('').update({ 'x/a': 1 }), () => od('x').update({ b: 2 })],
  },
  'update-then-set': {
    seed: { keep: true },
    steps: (od) => [() => od('').update({ a: 1 }), () => od('').set({ b: 2 })],
  },
  'set-then-update': {
    seed: { keep: true },
    steps: (od) => [() => od('').set({ a: 1 }), () => od('').update({ b: 2 })],
  },
  'update-then-remove': {
    seed: { keep: true },
    steps: (od) => [() => od('').update({ a: 1 }), () => od('').remove()],
  },
  'two-updates-then-cancel-path': {
    seed: { keep: true },
    steps: (od) => [() => od('').update({ a: 1 }), () => od('').update({ b: 2 }), () => od('').cancel()],
  },
  'two-updates-then-cancel-one-child': {
    seed: { keep: true },
    steps: (od) => [() => od('').update({ a: 1 }), () => od('').update({ b: 2 }), () => od('a').cancel()],
  },
  'update-object-then-deep-child': {
    seed: { keep: true, a: { x: 0, y: 0, keepA: true } },
    steps: (od) => [() => od('').update({ a: { x: 1, y: 2 } }), () => od('').update({ 'a/y': 3 })],
  },
  'remove-then-update': {
    seed: { keep: true },
    steps: (od) => [() => od('').remove(), () => od('').update({ b: 2 })],
  },
  'parent-update-child-set-parent-deep-update': {
    seed: { keep: true, sub: { old: 1, x: 0 } },
    steps: (od) => [
      () => od('').update({ other: 1 }),
      () => od('sub').set({ x: 1, y: 1 }),
      () => od('').update({ 'sub/x': 9 }),
    ],
  },
};

function sortKeys(value) {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(sortKeys);
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortKeys(value[key])]));
}

async function registerAll(db, root) {
  for (const [name, spec] of Object.entries(CASES)) {
    const base = `${root}/${name}`;
    await set(ref(db, base), spec.seed);
    const od = (child) => {
      const path = child === '' ? base : `${base}/${child}`;
      return onDisconnect(ref(db, path));
    };
    for (const step of spec.steps(od)) {
      await step();
    }
  }
  await set(ref(db, `${root}/_sentinel`), 'armed');
  await onDisconnect(ref(db, `${root}/_sentinel`)).set('drained');
}

async function readAll(db, root) {
  const results = {};
  for (const name of Object.keys(CASES)) {
    results[name] = sortKeys((await get(ref(db, `${root}/${name}`))).val());
  }
  const sentinel = (await get(ref(db, `${root}/_sentinel`))).val();
  return { sentinel, results };
}

const app = initializeApp({
  apiKey: 'demo',
  appId: 'demo',
  projectId: 'demo-app',
  databaseURL: 'https://demo-app-default-rtdb.firebaseio.com',
});
const db = getDatabase(app);
const [mode, root] = process.argv.slice(2);

if (mode === 'offline') {
  await registerAll(db, root);
  goOffline(db);
  await new Promise((resolve) => setTimeout(resolve, 200));
  goOnline(db);
  const deadline = Date.now() + 5_000;
  let payload = await readAll(db, root);
  while (payload.sentinel !== 'drained' && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 50));
    payload = await readAll(db, root);
  }
  console.log(`RESULT ${JSON.stringify(payload)}`);
  await deleteApp(app);
  process.exit(0);
}

if (mode === 'register-and-exit') {
  await registerAll(db, root);
  process.exit(0);
}

if (mode === 'read') {
  console.log(`RESULT ${JSON.stringify(await readAll(db, root))}`);
  await deleteApp(app);
  process.exit(0);
}

throw new Error(`unknown mode: ${mode}`);

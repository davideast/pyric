# Good and bad tests

## Good tests: behavioral and public-seam focused

```ts
// GOOD: Exercises public entrypoints and asserts observable behavior
test('setDoc denies unauthenticated write when rules require auth', async () => {
  const sandbox = createSandbox({
    firestoreRules: `
      rules_version = '2';
      service cloud.firestore {
        match /databases/{database}/documents {
          match /items/{id} {
            allow write: if request.auth != null;
          }
        }
      }
    `,
  });
  const db = getFirestore(sandbox.app);
  await expect(setDoc(doc(db, 'items/a1'), { count: 1 })).rejects.toThrow(/permission-denied/i);
});
```

Characteristics:

- verifies behavior callers depend on;
- imports only public entrypoints;
- survives internal splits and collaborator extraction;
- states WHAT holds, not HOW internals are wired;
- checks one coherent behavioral invariant per test.

## Bad tests: implementation-coupled

```ts
// BAD: Spies on internal evaluator collaborator and call count
test('setDoc calls rulesEvaluator.evaluateWrite once', async () => {
  const spy = spyOn(internalEvaluator, 'evaluateWrite');
  await setDoc(doc(db, 'items/a1'), { count: 1 });
  expect(spy).toHaveBeenCalledTimes(1);
});
```

Red flags:

- mocking or spying on internal collaborators;
- importing non-exported concept internals where a public surface exists;
- asserting internal call counts or execution order rather than outcomes;
- verifying state through a private backing map instead of public read APIs:

```ts
// BAD: Reaches into internal storage map
await createAccount(auth, { uid: 'u1', email: 'u1@example.com' });
expect(internalStore.accounts.get('u1')?.email).toBe('u1@example.com');

// GOOD: Reads back through the public interface
await createAccount(auth, { uid: 'u1', email: 'u1@example.com' });
const record = await adminAuth.getUser('u1');
expect(record.email).toBe('u1@example.com');
```

## Bad tests: tautological expectations

```ts
// BAD: Recomputes expected output the same way the implementation does
test('normalizes bucket path', () => {
  const raw = 'gs://bucket-a//docs/item.txt';
  const expected = raw.replace(/^gs:\/\/[^/]+\/+/, '');
  expect(normalizeObjectPath(raw)).toBe(expected);
});

// GOOD: Asserts an independent, concrete expected literal
test('normalizes bucket path', () => {
  expect(normalizeObjectPath('gs://bucket-a//docs/item.txt')).toBe('docs/item.txt');
});
```

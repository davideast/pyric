import assert from 'node:assert/strict';
import { FirebaseError } from 'pyric/app';

// This non-browser realm has no tab-sync transport to keep the process alive.
Reflect.deleteProperty(globalThis, 'BroadcastChannel');

const [service, name] = process.argv.slice(2);
const entry = new URL(`../../../../src/serve/entries/${service}.ts`, import.meta.url);
const sdk = await import(entry.href);
const callable = sdk[name];
assert.equal(typeof callable, 'function');
assert.equal({} instanceof callable, false);
for (const invoke of [() => Reflect.apply(callable, undefined, []), () => Reflect.construct(callable, [])]) {
  assert.throws(invoke, error => {
    assert.ok(error instanceof FirebaseError);
    assert.equal(error.code, `${service}/unsupported-in-served-mode`);
    assert.ok(error.message.includes(name));
    assert.ok(error.message.includes('not available'));
    return true;
  });
}

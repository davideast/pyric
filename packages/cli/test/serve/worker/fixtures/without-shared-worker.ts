// Reproduce another test file evaluating the entry before a browser exists.
Reflect.deleteProperty(globalThis, 'SharedWorker');
await import('../../../../src/serve/entries/worker-runtime.js');

import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';

describe('worker client port contract', () => {
  it('types the shared client against the methods every transport implements', () => {
    const handles = readFileSync(
      new URL('../../../src/serve/worker/client/handles.ts', import.meta.url),
      'utf8',
    );
    const serviceWorker = readFileSync(
      new URL('../../../src/serve/worker/client/service-worker-connection.ts', import.meta.url),
      'utf8',
    );

    expect(handles).toContain('export interface ClientPort');
    expect(serviceWorker).not.toContain('as unknown as MessagePort');
    expect(serviceWorker).toContain('satisfies ClientPort');
  });
});

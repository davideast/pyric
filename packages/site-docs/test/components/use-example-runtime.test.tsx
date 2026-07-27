import { JSDOM } from 'jsdom';
const dom = new JSDOM('<!doctype html><html><body></body></html>');
const globals = globalThis as Record<string, unknown>;
globals.window = dom.window;
globals.document = dom.window.document;
globals.HTMLElement = dom.window.HTMLElement;
globals.IS_REACT_ACT_ENVIRONMENT = true;

import { afterEach, describe, expect, it } from 'bun:test';
import { cleanup, renderHook } from '@testing-library/react';
import type { EmbeddedExampleRuntime } from '../../src/examples/embedded-runtime';
import type { PyricSnippetDefinition } from '../../src/examples/definition';
import { useExampleRuntime } from '../../src/components/use-example-runtime';

afterEach(() => cleanup());

describe('useExampleRuntime', () => {
  it('constructs one sandbox runtime across component re-renders', () => {
    const definition: PyricSnippetDefinition = {
      header: 'Runtime fixture',
      subLabel: 'Firestore',
      summary: 'Runs against an isolated sandbox.',
      docsPath: '/docs/examples/',
      service: 'firestore',
      firestore: {
        rules: "rules_version = '2'; service cloud.firestore { match /databases/{database}/documents { match /{document=**} { allow read, write: if true; } } }",
      },
      run: async () => undefined,
    };
    let constructions = 0;
    const runtime: EmbeddedExampleRuntime = {
      run: () => new Promise(() => {}),
      reset: () => runtime,
    };
    const createRuntime = () => {
      constructions += 1;
      return runtime;
    };

    const result = renderHook(() => useExampleRuntime(definition, createRuntime));
    result.rerender();
    result.rerender();

    expect(constructions).toBe(1);
  });
});

/** The switch that decides whether listener attribution runs at all. */
import { afterEach, describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import {
  configureListenerAttribution,
  listenerAttributionEnabled,
  listenerAttributionMode,
} from '../../../src/sandbox/attribution/attribution-mode.js';

function withNodeEnv(value: string | undefined, run: () => void): void {
  const previous = process.env.NODE_ENV;
  if (value === undefined) {
    delete process.env.NODE_ENV;
  } else {
    process.env.NODE_ENV = value;
  }
  try {
    run();
  } finally {
    if (previous === undefined) {
      delete process.env.NODE_ENV;
    } else {
      process.env.NODE_ENV = previous;
    }
  }
}

/** Run `body` the way a browser page or worker does: with no `process`. */
function withoutProcess(body: () => void): void {
  const g = globalThis as { process?: unknown };
  const real = g.process;
  delete g.process;
  try {
    expect('process' in globalThis).toBe(false);
    body();
  } finally {
    g.process = real;
  }
}

const SOURCE = new URL('../../../src/sandbox/attribution/attribution-mode.ts', import.meta.url);

/** The module's code, with its comments removed. */
function sourceCode(): string {
  return readFileSync(SOURCE, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
}

afterEach(() => {
  configureListenerAttribution('auto');
});

describe('listener attribution mode', () => {
  it('runs by default, because the mirror is a development tool', () => {
    withNodeEnv(undefined, () => {
      expect(listenerAttributionEnabled()).toBe(true);
    });
  });

  it('stops when the host process declares itself production', () => {
    withNodeEnv('production', () => {
      expect(listenerAttributionEnabled()).toBe(false);
    });
  });

  it('runs under any other declared environment', () => {
    withNodeEnv('test', () => {
      expect(listenerAttributionEnabled()).toBe(true);
    });
  });

  it('lets an explicit option turn it on inside a production environment', () => {
    withNodeEnv('production', () => {
      configureListenerAttribution('on');
      expect(listenerAttributionEnabled()).toBe(true);
    });
  });

  it('lets an explicit option turn it off outside one', () => {
    withNodeEnv('development', () => {
      configureListenerAttribution('off');
      expect(listenerAttributionEnabled()).toBe(false);
    });
  });

  it('hands the decision back to the environment on auto', () => {
    configureListenerAttribution('off');
    expect(listenerAttributionMode()).toBe('off');
    configureListenerAttribution('auto');
    withNodeEnv('production', () => {
      expect(listenerAttributionEnabled()).toBe(false);
    });
  });

  it('runs in a browser page or worker, where no process exists', () => {
    withoutProcess(() => {
      expect(listenerAttributionEnabled()).toBe(true);
    });
  });

  it('never reads import.meta.env, which the Vite dev server fills with every VITE_ variable (#1632)', () => {
    expect(sourceCode()).not.toContain('import.meta');
    expect(sourceCode()).toContain('process.env.NODE_ENV');
  });
});

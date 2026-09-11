/** The switch that decides whether listener attribution runs at all. */
import { afterEach, describe, expect, it } from 'bun:test';
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
});

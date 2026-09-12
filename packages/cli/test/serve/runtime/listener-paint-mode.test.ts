import { JSDOM } from 'jsdom';
import { describe, expect, it } from 'bun:test';
import {
  DEFAULT_LISTENER_PAINT_MODE,
  LISTENER_PAINT_MODE_KEY,
  isListenerPaintMode,
  pagePaintModeStorage,
  readListenerPaintMode,
  writeListenerPaintMode,
  type PaintModeStorage,
} from '../../../src/serve/runtime/listener-paint-mode.js';

function memoryStorage(initial: Record<string, string> = {}): PaintModeStorage {
  const store = new Map(Object.entries(initial));
  return {
    getItem: (key) => store.get(key) ?? null,
    setItem: (key, value) => {
      store.set(key, value);
    },
  };
}

const refusing: PaintModeStorage = {
  getItem() {
    throw new Error('blocked');
  },
  setItem() {
    throw new Error('blocked');
  },
};

describe('remembering the painting mode', () => {
  it('starts in Overview when nothing was kept', () => {
    expect(readListenerPaintMode(memoryStorage())).toBe('overview');
    expect(DEFAULT_LISTENER_PAINT_MODE).toBe('overview');
  });

  it('reads back the mode it wrote', () => {
    const storage = memoryStorage();
    writeListenerPaintMode(storage, 'flow');
    expect(storage.getItem(LISTENER_PAINT_MODE_KEY)).toBe('flow');
    expect(readListenerPaintMode(storage)).toBe('flow');
  });

  it('keeps its key under the pyric prefix', () => {
    expect(LISTENER_PAINT_MODE_KEY.startsWith('pyric:')).toBe(true);
  });

  it('falls back to the default for a value it does not recognise', () => {
    expect(readListenerPaintMode(memoryStorage({ [LISTENER_PAINT_MODE_KEY]: 'sideways' })))
      .toBe('overview');
  });

  it('treats a storage that refuses as no storage at all', () => {
    expect(readListenerPaintMode(refusing)).toBe('overview');
    expect(() => writeListenerPaintMode(refusing, 'flow')).not.toThrow();
    expect(readListenerPaintMode(null)).toBe('overview');
    expect(() => writeListenerPaintMode(undefined, 'flow')).not.toThrow();
  });

  it('names the two modes and nothing else', () => {
    expect(isListenerPaintMode('overview')).toBe(true);
    expect(isListenerPaintMode('flow')).toBe(true);
    expect(isListenerPaintMode('outline')).toBe(false);
    expect(isListenerPaintMode(null)).toBe(false);
  });

  it('finds the page own storage and round-trips through it', () => {
    const dom = new JSDOM('<!doctype html><body></body>', { url: 'http://localhost/' });
    const storage = pagePaintModeStorage(dom.window.document);
    expect(storage).not.toBeNull();
    writeListenerPaintMode(storage, 'flow');
    expect(readListenerPaintMode(pagePaintModeStorage(dom.window.document))).toBe('flow');
  });
});

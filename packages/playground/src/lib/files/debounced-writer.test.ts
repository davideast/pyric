import { describe, expect, test, beforeEach, afterEach, jest } from 'bun:test';
import { createDebouncedFileWriter } from './debounced-writer';

const PATH = '/workspace/src/App.tsx';

function setup() {
  const disk = new Map<string, string>();
  const written: Array<[string, string]> = [];
  const errors: unknown[] = [];
  const writer = createDebouncedFileWriter({
    delayMs: 300,
    read: async (path) => disk.get(path) ?? '',
    write: async (path, content) => {
      disk.set(path, content);
    },
    onWritten: (path, content) => written.push([path, content]),
    onError: (err) => errors.push(err),
  });
  return { disk, written, errors, writer };
}

async function flush() {
  for (let i = 0; i < 5; i++) await Promise.resolve();
}

describe('createDebouncedFileWriter', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  test('writes the typed content after the debounce delay', async () => {
    const { disk, written, writer } = setup();
    disk.set(PATH, 'old');
    writer.observe(PATH, 'old');
    writer.schedule(PATH, 'typed');
    jest.advanceTimersByTime(299);
    expect(disk.get(PATH)).toBe('old');
    jest.advanceTimersByTime(1);
    await flush();
    expect(disk.get(PATH)).toBe('typed');
    expect(written).toEqual([[PATH, 'typed']]);
  });

  test('a tool write observed on reload before the timer fires survives', async () => {
    const { disk, written, writer } = setup();
    disk.set(PATH, 'old');
    writer.observe(PATH, 'old');
    writer.schedule(PATH, 'typed against old');
    disk.set(PATH, 'tool content');
    expect(writer.observe(PATH, 'tool content')).toBe(true);
    expect(writer.hasPending(PATH)).toBe(false);
    jest.advanceTimersByTime(1000);
    await flush();
    expect(disk.get(PATH)).toBe('tool content');
    expect(written).toEqual([]);
  });

  test('a tool write the reload has not yet read survives the timer', async () => {
    const { disk, written, writer } = setup();
    disk.set(PATH, 'old');
    writer.observe(PATH, 'old');
    writer.schedule(PATH, 'typed against old');
    disk.set(PATH, 'tool content');
    jest.advanceTimersByTime(300);
    await flush();
    expect(disk.get(PATH)).toBe('tool content');
    expect(written).toEqual([]);
  });

  test('a reload of the editor own save keeps newer pending keystrokes', async () => {
    const { disk, writer } = setup();
    disk.set(PATH, 'old');
    writer.observe(PATH, 'old');
    writer.schedule(PATH, 'one');
    jest.advanceTimersByTime(300);
    await flush();
    writer.schedule(PATH, 'one two');
    expect(writer.observe(PATH, 'one')).toBe(false);
    expect(writer.hasPending(PATH)).toBe(true);
    jest.advanceTimersByTime(300);
    await flush();
    expect(disk.get(PATH)).toBe('one two');
  });

  test('a reload of another path leaves a pending save alone', async () => {
    const { disk, writer } = setup();
    disk.set(PATH, 'a');
    writer.observe(PATH, 'a');
    writer.schedule(PATH, 'a edited');
    writer.observe('/workspace/b.ts', 'b');
    jest.advanceTimersByTime(300);
    await flush();
    expect(disk.get(PATH)).toBe('a edited');
  });
});

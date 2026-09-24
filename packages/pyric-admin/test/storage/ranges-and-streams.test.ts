/**
 * `File.download` honours `start` and `end`, and `createReadStream` and
 * `createWriteStream` move bytes, on the in-process arm.
 */
import { afterEach, describe, expect, it } from 'bun:test';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { initializeSandbox } from 'pyric/sandbox';
import { deleteApp, getApps, initializeApp } from '../../src/app/index.js';
import { getStorage } from '../../src/storage/index.js';

afterEach(async () => {
  await Promise.all(getApps().map(app => deleteApp(app)));
});

const bytes = Buffer.from(Array.from({ length: 1000 }, (_, index) => index % 251));

function file(path: string) {
  const app = initializeApp({ sandbox: initializeSandbox() }, `ranges-${Math.random().toString(36).slice(2)}`);
  return getStorage(app).bucket().file(path);
}

async function collect(stream: NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk as Uint8Array));
  return Buffer.concat(chunks);
}

describe('ranges and streams, in-process', () => {
  it('download reads the inclusive range start..end', async () => {
    const target = file('media/take.wav');
    await target.save(bytes);
    const [span] = await target.download({ start: 100, end: 109 });
    expect([...span]).toEqual([...bytes.subarray(100, 110)]);
    const [tail] = await target.download({ start: 990 });
    expect([...tail]).toEqual([...bytes.subarray(990)]);
  });

  it('createReadStream streams the object, or a range of it', async () => {
    const target = file('media/take.wav');
    await target.save(bytes);
    expect((await collect(target.createReadStream())).equals(bytes)).toBe(true);
    expect([...(await collect(target.createReadStream({ start: 10, end: 19 })))]).toEqual([...bytes.subarray(10, 20)]);
  });

  it('createWriteStream stores what is piped into it', async () => {
    const target = file('media/written.wav');
    await pipeline(Readable.from([bytes.subarray(0, 400), bytes.subarray(400)]), target.createWriteStream({ contentType: 'audio/wav' }));
    const [stored] = await target.download();
    expect(stored.equals(bytes)).toBe(true);
  });
});

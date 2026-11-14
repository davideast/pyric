import { describe, expect, it } from 'bun:test';
import { PassThrough, Readable, Writable } from 'node:stream';
import type { LiveCallRecord } from '../../src/observe.js';
import { isAdminMethodGated, type AdminRow } from '../../src/admin/patch.js';
import { adminProjectGate, type AdminApp } from '../../src/admin/project-gate.js';
import { patchCreateReadStream, patchCreateWriteStream } from '../../src/admin/storage-streams.js';

const HOST_PROJECT = 'streams-host';

function makeApp(projectId: string): AdminApp {
  return { options: { projectId } };
}

describe('storage-streams', () => {
  it('marks createWriteStream and createReadStream gated, records host streams, and refuses cross-project streams', async () => {
    const records: LiveCallRecord[] = [];
    const writtenChunks: Buffer[] = [];

    class FakeFile {
      readonly projectId: string;
      readonly bucketName: string;
      readonly name: string;
      constructor(projectId: string, bucketName: string, name: string) {
        this.projectId = projectId;
        this.bucketName = bucketName;
        this.name = name;
      }
      createWriteStream(): Writable {
        return new Writable({
          write(chunk: Buffer, _enc, cb) {
            writtenChunks.push(Buffer.from(chunk));
            cb();
          },
        });
      }
      createReadStream(): Readable {
        return Readable.from([Buffer.from('payload')]);
      }
    }

    const row: AdminRow = {
      module: '@google-cloud/storage',
      observer: (rec) => {
        records.push(rec);
      },
      gate: adminProjectGate(HOST_PROJECT, () => undefined, {}),
      appOf: (self) => makeApp((self as FakeFile).projectId),
    };
    const helpers = {
      moduleName: '@google-cloud/storage',
      baseOf: (_method: string, _args: readonly unknown[], self: unknown) => {
        const f = self as FakeFile;
        return { projectId: f.projectId, bucket: f.bucketName, path: f.name };
      },
      codeOf: () => 'storage/unknown',
    };

    patchCreateWriteStream(FakeFile.prototype, row, helpers);
    patchCreateReadStream(FakeFile.prototype, row, helpers);

    expect(isAdminMethodGated(FakeFile.prototype.createWriteStream)).toBe(true);
    expect(isAdminMethodGated(FakeFile.prototype.createReadStream)).toBe(true);

    const hostFile = new FakeFile(HOST_PROJECT, `${HOST_PROJECT}.appspot.com`, 'docs/a.txt');
    await new Promise<void>((resolve, reject) => {
      const ws = hostFile.createWriteStream();
      ws.on('finish', () => resolve());
      ws.on('error', reject);
      ws.end(Buffer.from('hello'));
    });
    expect(Buffer.concat(writtenChunks).toString('utf8')).toBe('hello');

    const readChunks: Buffer[] = [];
    for await (const chunk of hostFile.createReadStream()) {
      readChunks.push(Buffer.from(chunk as Uint8Array));
    }
    expect(Buffer.concat(readChunks).toString('utf8')).toBe('payload');
    expect(records.map((r) => ({ name: r.name, usage: r.usage }))).toEqual([
      { name: 'File.createWriteStream', usage: { uploadedBytes: 5 } },
      { name: 'File.createReadStream', usage: { downloadedBytes: 7 } },
    ]);

    const otherFile = new FakeFile('other-project', 'other-project.appspot.com', 'docs/b.txt');
    const writeRefusal = await new Promise<string>((resolve) => {
      const ws = otherFile.createWriteStream();
      ws.once('error', (err: { code?: string }) => resolve(String(err.code)));
      ws.end(Buffer.from('nope'));
    });
    expect(writeRefusal).toBe('PYRIC_LIVE_REFUSED');

    const readRefusal = await new Promise<string>((resolve) => {
      const rs = otherFile.createReadStream() as PassThrough;
      rs.once('error', (err: { code?: string }) => resolve(String(err.code)));
      rs.resume();
    });
    expect(readRefusal).toBe('PYRIC_LIVE_REFUSED');
  });
});

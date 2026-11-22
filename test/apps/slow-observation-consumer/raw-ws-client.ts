import { randomBytes } from 'node:crypto';
import { connect, type Socket } from 'node:net';

export interface RawWsClient {
  readonly socket: Socket;
  readonly messages: unknown[];
  closeEvent: { code: number; reason: string } | null;
  sendJson(frame: unknown): void;
  waitFor(predicate: (msg: unknown) => boolean, timeoutMs?: number): Promise<unknown>;
  close(): void;
}

function encodeClientFrame(opcode: number, payload: Buffer): Buffer {
  const mask = randomBytes(4);
  let header: Buffer;
  if (payload.length < 126) {
    header = Buffer.alloc(6);
    header[0] = 0x80 | opcode;
    header[1] = 0x80 | payload.length;
    mask.copy(header, 2);
  } else if (payload.length < 65_536) {
    header = Buffer.alloc(8);
    header[0] = 0x80 | opcode;
    header[1] = 0x80 | 126;
    header.writeUInt16BE(payload.length, 2);
    mask.copy(header, 4);
  } else {
    header = Buffer.alloc(14);
    header[0] = 0x80 | opcode;
    header[1] = 0x80 | 127;
    header.writeBigUInt64BE(BigInt(payload.length), 2);
    mask.copy(header, 10);
  }
  const masked = Buffer.allocUnsafe(payload.length);
  for (let i = 0; i < payload.length; i += 1) {
    const byte = payload[i] ?? 0;
    const maskByte = mask[i & 3] ?? 0;
    masked[i] = byte ^ maskByte;
  }
  return Buffer.concat([header, masked]);
}

export async function openRawWsClient(port: number, path = '/__pyric/sandbox'): Promise<RawWsClient> {
  const socket = connect({ host: '127.0.0.1', port });
  socket.setNoDelay(true);

  const messages: unknown[] = [];
  const waiters: Array<{
    predicate: (msg: unknown) => boolean;
    resolve: (msg: unknown) => void;
    reject: (err: Error) => void;
  }> = [];

  const client: RawWsClient = {
    socket,
    messages,
    closeEvent: null,
    sendJson(frame: unknown): void {
      const bytes = Buffer.from(JSON.stringify(frame), 'utf8');
      socket.write(encodeClientFrame(0x1, bytes));
    },
    waitFor(predicate: (msg: unknown) => boolean, timeoutMs = 15_000): Promise<unknown> {
      for (const existing of messages) {
        if (predicate(existing)) return Promise.resolve(existing);
      }
      if (client.closeEvent !== null) {
        return Promise.reject(
          new Error(`Socket closed (${client.closeEvent.code}: ${client.closeEvent.reason})`),
        );
      }
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          const idx = waiters.indexOf(entry);
          if (idx >= 0) waiters.splice(idx, 1);
          reject(new Error(`Timed out after ${timeoutMs}ms waiting for WebSocket message`));
        }, timeoutMs);
        const entry = {
          predicate,
          resolve: (msg: unknown) => {
            clearTimeout(timer);
            resolve(msg);
          },
          reject: (err: Error) => {
            clearTimeout(timer);
            reject(err);
          },
        };
        waiters.push(entry);
      });
    },
    close(): void {
      socket.destroy();
    },
  };

  const deliverMessage = (msg: unknown): void => {
    messages.push(msg);
    for (let i = waiters.length - 1; i >= 0; i -= 1) {
      const waiter = waiters[i];
      if (waiter !== undefined && waiter.predicate(msg)) {
        waiters.splice(i, 1);
        waiter.resolve(msg);
      }
    }
  };

  const failWaiters = (err: Error): void => {
    const pending = waiters.splice(0);
    for (const waiter of pending) waiter.reject(err);
  };

  await new Promise<void>((resolve, reject) => {
    let upgraded = false;
    let buffer: Buffer = Buffer.alloc(0);
    let fragments: Buffer[] = [];

    const parseFrames = (): void => {
      for (;;) {
        if (buffer.length < 2) return;
        const b0 = buffer[0] ?? 0;
        const b1 = buffer[1] ?? 0;
        const fin = (b0 & 0x80) !== 0;
        const opcode = b0 & 0x0f;
        const masked = (b1 & 0x80) !== 0;
        let payloadLen = b1 & 0x7f;
        let offset = 2;
        if (payloadLen === 126) {
          if (buffer.length < 4) return;
          payloadLen = buffer.readUInt16BE(2);
          offset = 4;
        } else if (payloadLen === 127) {
          if (buffer.length < 10) return;
          payloadLen = Number(buffer.readBigUInt64BE(2));
          offset = 10;
        }
        const maskBytes = masked ? 4 : 0;
        if (buffer.length < offset + maskBytes + payloadLen) return;
        let payload = buffer.subarray(offset + maskBytes, offset + maskBytes + payloadLen);
        if (masked) {
          const mask = buffer.subarray(offset, offset + 4);
          const unmasked = Buffer.allocUnsafe(payloadLen);
          for (let i = 0; i < payloadLen; i += 1) {
            unmasked[i] = (payload[i] ?? 0) ^ (mask[i & 3] ?? 0);
          }
          payload = unmasked;
        }
        buffer = buffer.subarray(offset + maskBytes + payloadLen);

        if (opcode === 0x8) {
          const code = payload.length >= 2 ? payload.readUInt16BE(0) : 1005;
          const reason = payload.length > 2 ? payload.subarray(2).toString('utf8') : '';
          client.closeEvent = { code, reason };
          failWaiters(new Error(`WebSocket closed with ${code}: ${reason}`));
          return;
        }
        if (opcode === 0x9) {
          socket.write(encodeClientFrame(0x0a, payload));
          continue;
        }
        if (opcode === 0x0a) continue;
        if (opcode === 0x1 || opcode === 0x0) {
          fragments.push(Buffer.from(payload));
          if (fin) {
            const text = Buffer.concat(fragments).toString('utf8');
            fragments = [];
            deliverMessage(JSON.parse(text));
          }
        }
      }
    };

    socket.once('error', err => {
      if (!upgraded) reject(err);
      else failWaiters(err);
    });

    socket.once('close', () => {
      if (client.closeEvent === null) {
        client.closeEvent = { code: 1006, reason: 'tcp closed' };
      }
      failWaiters(new Error(`TCP socket closed (${client.closeEvent.code})`));
    });

    socket.on('data', (chunk: Buffer) => {
      buffer = buffer.length === 0 ? chunk : Buffer.concat([buffer, chunk]);
      if (!upgraded) {
        const headerEnd = buffer.indexOf('\r\n\r\n');
        if (headerEnd < 0) return;
        const head = buffer.subarray(0, headerEnd).toString('latin1');
        if (!head.startsWith('HTTP/1.1 101')) {
          reject(new Error(`Unexpected upgrade response: ${head.split('\r\n')[0]}`));
          socket.destroy();
          return;
        }
        upgraded = true;
        buffer = buffer.subarray(headerEnd + 4);
        resolve();
      }
      parseFrames();
    });

    socket.once('connect', () => {
      const key = randomBytes(16).toString('base64');
      socket.write(
        [
          `GET ${path} HTTP/1.1`,
          `Host: 127.0.0.1:${port}`,
          'Upgrade: websocket',
          'Connection: Upgrade',
          `Sec-WebSocket-Key: ${key}`,
          'Sec-WebSocket-Version: 13',
          `Origin: http://127.0.0.1:${port}`,
          '',
          '',
        ].join('\r\n'),
      );
    });
  });

  return client;
}

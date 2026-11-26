import { IncomingMessage, type ServerResponse } from 'node:http';
import { answerAndClose, BODY_TOO_LARGE_CODE } from '../bridge/server/peer.js';
import { getHeader } from './loopback-guard.js';

const NON_NEGATIVE_INT_RE = /^\d+$/;

function parseDeclaredContentLength(req: IncomingMessage): number | null {
  const header = getHeader(req, 'content-length');
  if (header === undefined) return null;
  let maxDeclared: number | null = null;
  for (const part of header.split(',')) {
    const trimmed = part.trim();
    if (!NON_NEGATIVE_INT_RE.test(trimmed)) continue;
    const value = Number(trimmed);
    if (!Number.isFinite(value)) continue;
    if (maxDeclared === null || value > maxDeclared) {
      maxDeclared = value;
    }
  }
  return maxDeclared;
}

function createBodyTooLargeError(limitBytes: number): Error {
  return Object.assign(new Error(`Request body exceeds ${limitBytes} bytes`), {
    code: BODY_TOO_LARGE_CODE,
  });
}

function toChunkBuffer(chunk: Buffer | Uint8Array | string): Buffer {
  if (typeof chunk === 'string') {
    return Buffer.from(chunk, 'utf8');
  }
  if (Buffer.isBuffer(chunk)) {
    return chunk;
  }
  return Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
}

/**
 * True when a real `IncomingMessage` still has unread request body bytes
 * (`Content-Length > 0` or `Transfer-Encoding` present).
 */
export function hasUnreadRequestBody(req: IncomingMessage): boolean {
  if (!(req instanceof IncomingMessage)) return false;
  if (req.complete || req.readableEnded) return false;
  const contentLength = getHeader(req, 'content-length')?.trim();
  const hasNonZeroLength = contentLength !== undefined && contentLength !== '' && contentLength !== '0';
  const hasTransferEncoding = getHeader(req, 'transfer-encoding') !== undefined;
  return hasNonZeroLength || hasTransferEncoding;
}

/**
 * Send a short plain-text refusal, using `answerAndClose` when unread request
 * bytes are in flight so keep-alive clients do not stall on the remainder.
 */
export function sendTextRefusal(
  req: IncomingMessage,
  res: ServerResponse,
  status: number,
  headers: Record<string, string>,
  body: string,
): void {
  if (hasUnreadRequestBody(req) && typeof req.once === 'function' && typeof req.resume === 'function') {
    answerAndClose(req, res, status, headers, body);
    return;
  }
  res.writeHead(status, headers).end(body);
}

/**
 * Answer `413 Payload Too Large` and close the connection cleanly so the
 * client receives the status without a socket reset or keep-alive stall.
 */
export function sendPayloadTooLarge(
  req: IncomingMessage,
  res: ServerResponse,
  message = 'Payload Too Large',
): void {
  const headers = { 'content-type': 'text/plain; charset=utf-8' };
  if (typeof req.once === 'function' && typeof req.resume === 'function') {
    answerAndClose(req, res, 413, headers, message);
    return;
  }
  if (!res.headersSent) {
    res.writeHead(413, { ...headers, connection: 'close' }).end(message);
  }
}

/**
 * Collect a request body as a UTF-8 string up to `limitBytes` UTF-8 bytes.
 *
 * Pre-checks `Content-Length` when declared and counts exact UTF-8 byte lengths
 * across every incoming chunk (handling chunked streams and multi-byte UTF-8
 * split across chunk boundaries). Past the limit, buffers are cleared
 * immediately and remaining bytes are discarded without destroying the socket
 * so the caller can send `413 Payload Too Large`.
 */
export function readBoundedUtf8Body(req: IncomingMessage, limitBytes: number): Promise<string> {
  const declared = parseDeclaredContentLength(req);
  if (declared !== null && declared > limitBytes) {
    return Promise.reject(createBodyTooLargeError(limitBytes));
  }

  return new Promise<string>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;

    req.on('data', (chunk: Buffer | Uint8Array | string) => {
      if (settled) return;
      const bytes = toChunkBuffer(chunk);
      size += bytes.byteLength;
      if (size > limitBytes) {
        settled = true;
        chunks.length = 0;
        reject(createBodyTooLargeError(limitBytes));
        return;
      }
      chunks.push(bytes);
    });

    req.on('end', () => {
      if (settled) return;
      settled = true;
      resolve(Buffer.concat(chunks, size).toString('utf8'));
    });

    req.on('error', (error: Error) => {
      if (settled) return;
      settled = true;
      chunks.length = 0;
      reject(error);
    });

    req.on('close', () => {
      if (settled) return;
      if (req instanceof IncomingMessage && !req.complete) {
        settled = true;
        chunks.length = 0;
        reject(new Error('Request aborted before body completed'));
      }
    });
  });
}

/**
 * Frame-based Storage byte transfer over MessagePort / WebSocket when no HTTP
 * byte route is advertised.
 */
import {
  base64ToBytes,
  bytesToBase64,
  MAX_STORAGE_OBJECT_BYTES,
  MAX_STORAGE_PART_BYTES,
  storageQuotaExceeded,
} from '../protocol.js';
import type { OpMessage } from '../protocol.js';
import { dataRpc, nextId } from './core.js';
import { reserveSend, type SendReservation } from './send-order.js';
import {
  committedFrom,
  rollbackField,
  type CommittedUpload,
} from './storage-byte-route.js';
import {
  bucketWire,
  getMetadata,
  type ClientSettableMetadata,
  type ClientStorageReference,
} from './storage.js';

export async function readStorageBytesAsFrames(
  reference: ClientStorageReference,
  reservation: SendReservation | undefined,
): Promise<{ bytes: Uint8Array; contentType?: string; size: number }> {
  const wireBucket = bucketWire(reference);
  try {
    const request: OpMessage & {
      method: 'storage.getBytes';
      path: string;
      bucket?: string;
    } = {
      t: 'op',
      id: nextId(),
      method: 'storage.getBytes',
      path: reference.fullPath,
    };
    if (wireBucket.bucket !== undefined) {
      request.bucket = wireBucket.bucket;
    }
    const res = (await dataRpc(reference.port, request, reservation)) as {
      dataB64: string;
      contentType?: string;
      size: number;
    };
    return {
      bytes: base64ToBytes(res.dataB64),
      contentType: res.contentType,
      size: res.size,
    };
  } catch (err: unknown) {
    const code = (err as { code?: string })?.code;
    const isTooLarge = code === 'payload-too-large';
    if (!isTooLarge) {
      throw err;
    }
    const meta = await getMetadata(reference);
    const byteParts: Uint8Array[] = [];
    let offset = 0;
    while (offset < meta.size) {
      const length = Math.min(MAX_STORAGE_PART_BYTES, meta.size - offset);
      const chunkRequest: OpMessage & {
        method: 'storage.getBytes';
        path: string;
        bucket?: string;
        offset: number;
        length: number;
        expectedGeneration: string;
      } = {
        t: 'op',
        id: nextId(),
        method: 'storage.getBytes',
        path: reference.fullPath,
        offset,
        length,
        expectedGeneration: meta.generation,
      };
      if (wireBucket.bucket !== undefined) {
        chunkRequest.bucket = wireBucket.bucket;
      }
      const chunkRes = (await dataRpc(reference.port, chunkRequest)) as {
        dataB64: string;
        contentType?: string;
        size: number;
      };
      byteParts.push(base64ToBytes(chunkRes.dataB64));
      offset += length;
    }
    const combined = new Uint8Array(meta.size);
    let pos = 0;
    for (const part of byteParts) {
      combined.set(part, pos);
      pos += part.byteLength;
    }
    return {
      bytes: combined,
      contentType: meta.contentType,
      size: meta.size,
    };
  }
}

/**
 * A Blob's bytes arrive only after an await, so the upload claims its place in
 * the call order first: operations the app issues after it wait until its
 * first frame is sent, or until reading the Blob fails.
 */
export async function uploadBlobInOrder(
  reference: ClientStorageReference,
  data: Blob,
  metadata: ClientSettableMetadata | undefined,
  rollback: boolean,
  claimed?: SendReservation,
): Promise<CommittedUpload> {
  const tooLarge = data.size > MAX_STORAGE_OBJECT_BYTES;
  if (tooLarge) {
    throw storageQuotaExceeded(data.size, `uploadBytes payload for '${reference.fullPath}'`);
  }
  let contentType: string | undefined;
  if (data.type !== '') {
    contentType = data.type;
  }
  if (metadata?.contentType !== undefined && metadata.contentType !== '') {
    contentType = metadata.contentType;
  }
  let reservation = claimed;
  if (reservation === undefined) {
    reservation = reserveSend(reference.port);
  }
  try {
    const bytes = new Uint8Array(await data.arrayBuffer());
    return await uploadByteArray(reference, bytes, contentType, metadata, rollback, reservation);
  } finally {
    reservation.release();
  }
}

/** Upload bytes in one frame, or in parts above 4 MiB. The first frame goes in `reservation`'s place. */
export async function uploadByteArray(
  reference: ClientStorageReference,
  bytes: Uint8Array,
  contentType: string | undefined,
  metadata: ClientSettableMetadata | undefined,
  rollback: boolean,
  reservation?: SendReservation,
): Promise<CommittedUpload> {
  if (bytes.byteLength > MAX_STORAGE_OBJECT_BYTES) {
    throw storageQuotaExceeded(bytes.byteLength, `uploadBytes payload for '${reference.fullPath}'`);
  }
  const wireBucket = bucketWire(reference);
  const rollbackOpt = rollbackField(rollback);

  if (bytes.byteLength <= MAX_STORAGE_PART_BYTES) {
    const putMessage: OpMessage & {
      method: 'storage.putBytes';
      path: string;
      bucket?: string;
      dataB64: string;
      contentType?: string;
      metadata?: Record<string, unknown>;
      rollback?: true;
    } = {
      t: 'op',
      id: nextId(),
      method: 'storage.putBytes',
      path: reference.fullPath,
      dataB64: bytesToBase64(bytes),
    };
    if (wireBucket.bucket !== undefined) {
      putMessage.bucket = wireBucket.bucket;
    }
    if (contentType !== undefined) {
      putMessage.contentType = contentType;
    }
    if (metadata !== undefined) {
      putMessage.metadata = metadata as Record<string, unknown>;
    }
    if (rollbackOpt.rollback === true) {
      putMessage.rollback = true;
    }
    const storing = dataRpc(reference.port, putMessage, reservation);
    reservation?.release();
    return committedFrom(reference, await storing);
  }

  const beginMessage: OpMessage & {
    method: 'storage.beginUpload';
    path: string;
    bucket?: string;
    size: number;
    contentType?: string;
    metadata?: Record<string, unknown>;
  } = {
    t: 'op',
    id: nextId(),
    method: 'storage.beginUpload',
    path: reference.fullPath,
    size: bytes.byteLength,
  };
  if (wireBucket.bucket !== undefined) {
    beginMessage.bucket = wireBucket.bucket;
  }
  if (contentType !== undefined) {
    beginMessage.contentType = contentType;
  }
  if (metadata !== undefined) {
    beginMessage.metadata = metadata as Record<string, unknown>;
  }
  const beginning = dataRpc(reference.port, beginMessage, reservation);
  reservation?.release();
  const beginRes = (await beginning) as { uploadId: string };

  const uploadId = beginRes.uploadId;
  try {
    let offset = 0;
    let partIndex = 0;
    while (offset < bytes.byteLength) {
      const nextOffset = Math.min(offset + MAX_STORAGE_PART_BYTES, bytes.byteLength);
      const partSlice = bytes.subarray(offset, nextOffset);
      await dataRpc(reference.port, {
        t: 'op',
        id: nextId(),
        method: 'storage.putPart',
        uploadId,
        partIndex,
        dataB64: bytesToBase64(partSlice),
      });
      offset = nextOffset;
      partIndex += 1;
    }
    const finishMessage: OpMessage & {
      method: 'storage.finishUpload';
      uploadId: string;
      rollback?: true;
    } = {
      t: 'op',
      id: nextId(),
      method: 'storage.finishUpload',
      uploadId,
    };
    if (rollbackOpt.rollback === true) {
      finishMessage.rollback = true;
    }
    const stored = await dataRpc(reference.port, finishMessage);
    return committedFrom(reference, stored);
  } catch (err) {
    try {
      await dataRpc(reference.port, {
        t: 'op',
        id: nextId(),
        method: 'storage.abortUpload',
        uploadId,
      });
    } catch {
      // Secondary abort best effort.
    }
    throw err;
  }
}

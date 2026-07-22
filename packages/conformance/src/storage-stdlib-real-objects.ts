import { jsonRequest, type AccessHeaders } from './storage-stdlib-real-api.ts';
import { type RequestBudget } from './storage-stdlib-real-budget.ts';

export type StorageDecision = { allowed: boolean; code?: string; message?: string };

export interface GcsObject {
  name: string;
  bucket: string;
  generation: string;
  metageneration: string;
  size: string;
  md5Hash: string;
  crc32c: string;
  etag: string;
  timeCreated: string;
  updated: string;
  metadata?: Record<string, string>;
}

export async function gcsUpload(
  bucket: string,
  path: string,
  payload: Uint8Array,
  headers: AccessHeaders,
  budget: RequestBudget,
): Promise<GcsObject> {
  budget.take('storage');
  return jsonRequest<GcsObject>(
    `https://storage.googleapis.com/upload/storage/v1/b/${encodeURIComponent(bucket)}/o?uploadType=media&name=${encodeURIComponent(path)}`,
    {
      method: 'POST',
      headers: { ...headers.auth, 'Content-Type': 'application/octet-stream' },
      body: payload.buffer as ArrayBuffer,
    },
    `upload seed object ${path}`,
  );
}

export async function gcsMetadata(
  bucket: string,
  path: string,
  headers: AccessHeaders,
  budget: RequestBudget,
): Promise<GcsObject> {
  budget.take('storage');
  return jsonRequest<GcsObject>(
    `https://storage.googleapis.com/storage/v1/b/${encodeURIComponent(bucket)}/o/${encodeURIComponent(path)}`,
    { headers: headers.auth },
    `read object metadata ${path}`,
  );
}

export async function deleteStorageObjects(
  bucket: string,
  prefix: string,
  objects: Set<string>,
  headers: AccessHeaders,
  budget: RequestBudget,
): Promise<boolean> {
  for (const path of objects) {
    budget.take('storage');
    const response = await fetch(
      `https://storage.googleapis.com/storage/v1/b/${encodeURIComponent(bucket)}/o/${encodeURIComponent(path)}`,
      { method: 'DELETE', headers: headers.auth },
    );
    if (!response.ok && response.status !== 404) {
      throw new Error(`delete probe object failed: ${response.status} ${await response.text()}`);
    }
  }
  budget.take('storage');
  const list = await jsonRequest<{ items?: unknown[] }>(
    `https://storage.googleapis.com/storage/v1/b/${encodeURIComponent(bucket)}/o?prefix=${encodeURIComponent(prefix)}`,
    { headers: headers.auth },
    'verify object cleanup',
  );
  return (list.items?.length ?? 0) === 0;
}

export function storageDecision(error?: unknown): StorageDecision {
  if (!error) return { allowed: true };
  return {
    allowed: false,
    code: (error as { code?: string }).code,
    message: error instanceof Error ? error.message : String(error),
  };
}

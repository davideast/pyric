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

type FetchRequest = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

async function clientDecision(response: Response): Promise<StorageDecision> {
  if (response.ok) return storageDecision();
  const text = await response.text();
  let code = String(response.status);
  let message = text || response.statusText;
  try {
    const parsed = JSON.parse(text) as { error?: { code?: string | number; message?: string } };
    code = String(parsed.error?.code ?? response.status);
    message = parsed.error?.message ?? message;
  } catch {
    // Preserve the HTTP status fallback when the backend body is not JSON.
  }
  return { allowed: false, code, message };
}

export async function firebaseStorageUpload(
  bucket: string,
  path: string,
  payload: Uint8Array,
  budget: RequestBudget,
  request: FetchRequest = fetch,
): Promise<StorageDecision> {
  budget.take('storage');
  const boundary = 'pyric-storage-probe';
  const metadata = JSON.stringify({ name: path, contentType: 'application/octet-stream' });
  const body = new Blob([
    `--${boundary}\r\nContent-Type: application/json; charset=utf-8\r\n\r\n${metadata}`,
    `\r\n--${boundary}\r\nContent-Type: application/octet-stream\r\n\r\n`,
    payload.slice().buffer as ArrayBuffer,
    `\r\n--${boundary}--`,
  ]);
  try {
    const response = await request(
      `https://firebasestorage.googleapis.com/v0/b/${encodeURIComponent(bucket)}/o?name=${encodeURIComponent(path)}`,
      {
        method: 'POST',
        headers: {
          'Content-Type': `multipart/related; boundary=${boundary}`,
          'X-Goog-Upload-Protocol': 'multipart',
        },
        body,
      },
    );
    return clientDecision(response);
  } catch (error) {
    return storageDecision(error);
  }
}

export async function firebaseStorageMetadata(
  bucket: string,
  path: string,
  budget: RequestBudget,
  request: FetchRequest = fetch,
): Promise<StorageDecision> {
  budget.take('storage');
  try {
    const response = await request(
      `https://firebasestorage.googleapis.com/v0/b/${encodeURIComponent(bucket)}/o/${encodeURIComponent(path)}`,
    );
    return clientDecision(response);
  } catch (error) {
    return storageDecision(error);
  }
}

export async function firebaseStorageMetadataUpdate(
  bucket: string,
  path: string,
  metadata: Record<string, string>,
  budget: RequestBudget,
  request: FetchRequest = fetch,
): Promise<StorageDecision> {
  budget.take('storage');
  try {
    const response = await request(
      `https://firebasestorage.googleapis.com/v0/b/${encodeURIComponent(bucket)}/o/${encodeURIComponent(path)}`,
      { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ metadata }) },
    );
    return clientDecision(response);
  } catch (error) {
    return storageDecision(error);
  }
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
  request: FetchRequest = fetch,
): Promise<boolean> {
  const deleteObject = async (path: string): Promise<void> => {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      budget.take('storage');
      try {
        const response = await request(
          `https://storage.googleapis.com/storage/v1/b/${encodeURIComponent(bucket)}/o/${encodeURIComponent(path)}`,
          { method: 'DELETE', headers: headers.auth },
        );
        if (response.ok || response.status === 404) return;
      } catch {
        continue;
      }
    }
  };
  const listObjects = async (label: string): Promise<Array<{ name?: string }>> => {
    let lastResponse: Response | undefined;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      budget.take('storage');
      try {
        lastResponse = await request(
          `https://storage.googleapis.com/storage/v1/b/${encodeURIComponent(bucket)}/o?prefix=${encodeURIComponent(prefix)}`,
          { headers: headers.auth },
        );
        if (lastResponse.ok) {
          return ((await lastResponse.json()) as { items?: Array<{ name?: string }> }).items ?? [];
        }
      } catch {
        continue;
      }
    }
    throw new Error(`${label} failed: ${lastResponse?.status ?? 'no response'}`);
  };
  for (const path of objects) {
    await deleteObject(path);
  }
  const list = await listObjects('verify object cleanup');
  for (const item of list) {
    if (!item.name || objects.has(item.name)) continue;
    await deleteObject(item.name);
  }
  return (await listObjects('verify final object cleanup')).length === 0;
}

export function storageDecision(error?: unknown): StorageDecision {
  if (!error) return { allowed: true };
  return {
    allowed: false,
    code: (error as { code?: string }).code,
    message: error instanceof Error ? error.message : String(error),
  };
}

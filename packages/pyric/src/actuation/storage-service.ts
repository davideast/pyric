/**
 * Pure domain service for Cloud Storage operations (`manageStorageFiles`):
 * upload (base64), download (`data:` URI), delete, and list.
 */

import type { LocalSandbox } from 'pyric/sandbox';
import {
  getStorageSandbox,
  ref,
  uploadString,
  getDownloadURL,
  deleteObject,
  listAll,
} from 'pyric/storage';
import { getAdminStorageSandbox } from 'pyric/storage/internal';
import { resolveAuthContext, type AuthOverrideInput } from './data-service.js';

export interface ManageStorageFilesInput {
  action: 'upload' | 'download' | 'delete' | 'list';
  bucket?: string;
  path: string;
  base64Content?: string;
  contentType?: string;
  customMetadataJson?: string;
  customMetadata?: Record<string, string>;
  auth?: AuthOverrideInput;
}

export interface ManageStorageFilesOutput {
  ok: boolean;
  action: 'upload' | 'download' | 'delete' | 'list';
  path: string;
  dataUri?: string;
  base64Content?: string;
  contentType?: string;
  customMetadata?: Record<string, string>;
  items?: string[];
  prefixes?: string[];
  error?: string;
}

export async function manageStorageFiles(
  sandbox: LocalSandbox,
  input: ManageStorageFilesInput
): Promise<ManageStorageFilesOutput> {
  try {
    const { isAdmin, context } = resolveAuthContext(sandbox, input.auth);
    const storage = isAdmin
      ? getAdminStorageSandbox(sandbox)
      : getStorageSandbox(context);

    const objectRef = ref(storage, input.path);

    if (input.action === 'upload') {
      if (!input.base64Content) {
        throw new Error('base64Content is required for storage upload action');
      }
      const customMetadata =
        input.customMetadata ??
        (input.customMetadataJson
          ? (JSON.parse(input.customMetadataJson) as Record<string, string>)
          : undefined);

      const uploadResult = await uploadString(objectRef, input.base64Content, 'base64', {
        contentType: input.contentType ?? 'application/octet-stream',
        customMetadata,
      });

      return {
        ok: true,
        action: 'upload',
        path: uploadResult.metadata.fullPath,
        contentType: uploadResult.metadata.contentType,
        customMetadata: uploadResult.metadata.customMetadata,
      };
    }

    if (input.action === 'download') {
      const dataUri = await getDownloadURL(objectRef);
      return {
        ok: true,
        action: 'download',
        path: input.path,
        dataUri,
      };
    }

    if (input.action === 'delete') {
      await deleteObject(objectRef);
      return {
        ok: true,
        action: 'delete',
        path: input.path,
      };
    }

    if (input.action === 'list') {
      const listRes = await listAll(objectRef);
      return {
        ok: true,
        action: 'list',
        path: input.path,
        items: listRes.items.map((item) => item.fullPath),
        prefixes: listRes.prefixes.map((prefix) => prefix.fullPath),
      };
    }

    return {
      ok: false,
      action: input.action,
      path: input.path,
      error: `Unsupported storage action: ${input.action}`,
    };
  } catch (err) {
    return {
      ok: false,
      action: input.action,
      path: input.path,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

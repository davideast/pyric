/**
 * `pyric-admin/storage` public re-export barrel.
 */

export { FirebaseStorageError, StorageErrorCode } from './error.js';
export type { DeleteFilesOptions, GetFilesApiResponse, GetFilesOptions } from './file-query.js';
export type { GetFilesResponse } from './get-files.js';
export type { FileMetadata, FileMetadataUpdate } from './metadata-codec.js';
export { getDownloadURL, getStorage } from './storage-service.js';
export type {
  Bucket,
  CopyDestination,
  CopyOptions,
  CreateReadStreamOptions,
  CreateResumableUploadOptions,
  CreateWriteStreamOptions,
  DownloadOptions,
  File,
  GetSignedUrlOptions,
  SaveOptions,
  Storage,
  StorageApp,
} from './types.js';

import { observeStorageOperation } from '../sandbox/internal/storage-activity.js';
import { rulesBucketName } from './sandbox/rules-bucket-name.js';
import { TARGET_SYMBOL, type Target } from './service.js';

/**
 * The bucket a sandbox reference's call names in its events: the name the app
 * knows it by, not the store key `ref.bucket` holds. Reads the handle without
 * throwing, so a reference the call itself rejects still records.
 */
function bucketName(ref: { readonly storage?: object; readonly bucket: string }): string {
  const target = (ref.storage as { [TARGET_SYMBOL]?: Target } | undefined)?.[TARGET_SYMBOL];
  return target === undefined ? ref.bucket : rulesBucketName(target.bucket, target.bucketName);
}
import { uploadBytes as rawuploadBytes, uploadString as rawuploadString } from './upload.js';
export const uploadBytes: typeof rawuploadBytes = observeStorageOperation('uploadBytes', rawuploadBytes, bucketName);
export const uploadString: typeof rawuploadString = observeStorageOperation('uploadString', rawuploadString, bucketName);
import { uploadBytesResumable as rawuploadBytesResumable } from './resumable.js';
export const uploadBytesResumable: typeof rawuploadBytesResumable = observeStorageOperation('uploadBytesResumable', rawuploadBytesResumable, bucketName);
import { getBytes as rawgetBytes, getBlob as rawgetBlob, getDownloadURL as rawgetDownloadURL, deleteObject as rawdeleteObject } from './download.js';
export const getBytes: typeof rawgetBytes = observeStorageOperation('getBytes', rawgetBytes, bucketName);
export const getBlob: typeof rawgetBlob = observeStorageOperation('getBlob', rawgetBlob, bucketName);
export const getDownloadURL: typeof rawgetDownloadURL = observeStorageOperation('getDownloadURL', rawgetDownloadURL, bucketName);
export const deleteObject: typeof rawdeleteObject = observeStorageOperation('deleteObject', rawdeleteObject, bucketName);
import { getMetadata as rawgetMetadata, updateMetadata as rawupdateMetadata } from './metadata.js';
export const getMetadata: typeof rawgetMetadata = observeStorageOperation('getMetadata', rawgetMetadata, bucketName);
export const updateMetadata: typeof rawupdateMetadata = observeStorageOperation('updateMetadata', rawupdateMetadata, bucketName);
import { listAll as rawlistAll } from './list.js';
export const listAll: typeof rawlistAll = observeStorageOperation('listAll', rawlistAll, bucketName);

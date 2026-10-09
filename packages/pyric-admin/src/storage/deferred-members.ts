/**
 * The `@google-cloud/storage` `Bucket` and `File` methods the sandbox does
 * not model. Each one is defined on the sandbox handles as a deferred member
 * that throws, or rejects for a method whose upstream form returns a
 * promise, a `PyricDeferredApiError` naming the method, instead of reading as
 * `undefined` at the call site.
 *
 * Properties and the inherited `EventEmitter` methods are not stubbed; they
 * are listed with their reason in the `pyric-admin` surface allowlist.
 */
import type { DeferredMembers } from 'pyric/app/internal';

export const BUCKET_DEFERRED_MEMBERS: DeferredMembers = {
  async: [
    'addLifecycleRule',
    'combine',
    'create',
    'createChannel',
    'createNotification',
    'delete',
    'deleteFiles',
    'deleteLabels',
    'disableRequesterPays',
    'enableLogging',
    'enableRequesterPays',
    'exists',
    'get',
    'getFiles',
    'getLabels',
    'getMetadata',
    'getNotifications',
    'getSignedUrl',
    'lock',
    'makePrivate',
    'makePublic',
    'removeRetentionPeriod',
    'request',
    'restore',
    'setCorsConfiguration',
    'setLabels',
    'setMetadata',
    'setRetentionPeriod',
    'setStorageClass',
    'upload',
  ],
  sync: ['getFilesStream', 'getId', 'getRequestInterceptors', 'notification', 'requestStream', 'setUserProject'],
};

export const FILE_DEFERRED_MEMBERS: DeferredMembers = {
  async: [
    'copy',
    'create',
    'generateSignedPostPolicyV2',
    'generateSignedPostPolicyV4',
    'get',
    'getExpirationDate',
    'isPublic',
    'makePrivate',
    'makePublic',
    'move',
    'moveFileAtomic',
    'rename',
    'request',
    'restore',
    'rotateEncryptionKey',
    'setStorageClass',
  ],
  sync: ['getRequestInterceptors', 'publicUrl', 'requestStream', 'setEncryptionKey', 'setUserProject'],
};

/**
 * Declarative SDK service model for modular Cloud Storage
 * (`firebase/storage`, `@firebase/storage`, `pyric/storage`,
 * `firebase-admin/storage`, and `pyric-admin/storage`).
 */
import type { OpSpec, SdkServiceModel } from './types.js';

const ADMIN_FILE_METHODS: Readonly<Record<string, OpSpec>> = {
  save: {
    op: 'uploadBytes',
    write: true,
    usesReceiverRef: true,
    admin: true,
    uploadPayload: {
      dataArg: 0,
      metadataArg: 1,
      customMetadataProp: 'metadata',
      stringData: true,
    },
  },
  delete: {
    op: 'deleteObject',
    write: true,
    usesReceiverRef: true,
    admin: true,
  },
  setMetadata: {
    op: 'updateMetadata',
    write: true,
    usesReceiverRef: true,
    admin: true,
    uploadPayload: {
      metadataArg: 0,
      customMetadataProp: 'metadata',
    },
  },
  download: {
    op: 'getBytes',
    read: true,
    usesReceiverRef: true,
    admin: true,
  },
  getMetadata: {
    op: 'getMetadata',
    read: true,
    usesReceiverRef: true,
    admin: true,
  },
};

export const STORAGE_SERVICE_MODEL: SdkServiceModel = {
  service: 'storage',
  modules: [
    'firebase/storage',
    '@firebase/storage',
    'pyric/storage',
    'firebase-admin/storage',
    'pyric-admin/storage',
  ],
  adminModules: ['firebase-admin/storage', 'pyric-admin/storage'],
  handleFactories: {
    getStorage: { resourceArgIndex: 1, singleStringArgIsResource: true },
    getAdminStorage: { resourceArgIndex: 1, singleStringArgIsResource: true },
  },
  handleSubFactories: {
    bucket: { resourceArgIndex: 0, singleStringArgIsResource: true },
  },
  handleRefMethods: {
    file: { refKind: 'object' },
  },
  refConstructors: {
    ref: { refKind: 'object' },
    refFromURL: { refKind: 'object', mode: 'url' },
  },
  constraints: {},
  operations: {
    uploadBytes: {
      op: 'uploadBytes',
      write: true,
      uploadPayload: { dataArg: 1, metadataArg: 2 },
    },
    uploadBytesResumable: {
      op: 'uploadBytesResumable',
      write: true,
      uploadPayload: { dataArg: 1, metadataArg: 2 },
    },
    uploadString: {
      op: 'uploadString',
      write: true,
      uploadPayload: { dataArg: 1, formatArg: 2, metadataArg: 3, stringData: true },
    },
    deleteObject: {
      op: 'deleteObject',
      write: true,
    },
    updateMetadata: {
      op: 'updateMetadata',
      write: true,
      uploadPayload: { metadataArg: 1 },
    },
    getDownloadURL: { op: 'getDownloadURL', read: true },
    getBytes: { op: 'getBytes', read: true },
    getBlob: { op: 'getBlob', read: true },
    getStream: { op: 'getStream', read: true },
    getMetadata: { op: 'getMetadata', read: true },
    list: { op: 'list', read: true },
    listAll: { op: 'listAll', read: true },
  },
  refMethods: ADMIN_FILE_METHODS,
  specialStrings: {
    'StringFormat.RAW': 'raw',
    'StringFormat.BASE64': 'base64',
    'StringFormat.BASE64URL': 'base64url',
    'StringFormat.DATA_URL': 'data_url',
  },
  nestedFieldSeparator: '.',
  defaultRefKind: 'object',
  queryBaseRefKind: 'object',
};

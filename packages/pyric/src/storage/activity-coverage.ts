/** Public Storage operations measured once at their SDK boundary. */
export const storageActivityCoverage = {
  service: 'storage',
  read: ['getBytes', 'getBlob', 'getDownloadURL', 'getMetadata', 'listAll'],
  write: ['uploadBytes', 'uploadString', 'uploadBytesResumable', 'updateMetadata', 'deleteObject'],
  listener: [],
  untrackedMethods: [],
} as const;

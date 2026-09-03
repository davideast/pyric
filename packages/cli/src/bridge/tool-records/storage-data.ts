import type { ToolRecord } from '../tool-records.js';
export default {
  name: 'storage_data',
  order: 85,
  description:
    'Cloud Storage objects in the connected sandbox: upload, download, list, metadata and delete. Every op runs as admin and bypasses rules unless `as` names a user, in which case rules are enforced for that user.',
  ops: {
    upload: { transport: 'forwarded', factory: 'storage-data', handler: 'storage_upload_object' },
    download: { transport: 'forwarded', factory: 'storage-data', handler: 'storage_download_object' },
    list: { transport: 'forwarded', factory: 'storage-data', handler: 'storage_list_objects' },
    metadata: { transport: 'forwarded', factory: 'storage-data', handler: 'storage_object_metadata' },
    delete: { transport: 'forwarded', factory: 'storage-data', handler: 'storage_delete_object' },
  },
} as const satisfies ToolRecord;

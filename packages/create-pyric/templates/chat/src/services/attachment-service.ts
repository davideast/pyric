import { deleteObject, getDownloadURL, ref, uploadBytes } from 'firebase/storage';
import { collection, doc, serverTimestamp, setDoc, Timestamp, updateDoc } from 'firebase/firestore';
import { auth, db, storage } from '../firebase/app';
import { asAttachmentId, type Attachment, type AttachmentDocument, type CreateAttachmentInput, ServiceError, type UploadTarget } from '../firebase/types';
import { mapFirestoreError, requireUid } from './firestore-helpers';

const MAX_SIZE = 10 * 1024 * 1024;
const CONTENT_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'application/pdf', 'text/plain']);

const safeName = (value: string): string => value.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 120) || 'file';

export class AttachmentService {
  async createUpload(input: CreateAttachmentInput): Promise<UploadTarget> {
    const uid = requireUid(auth.currentUser?.uid);
    if (input.sizeBytes <= 0 || input.sizeBytes > MAX_SIZE) throw new ServiceError('invalid-input', 'Attachment is too large');
    if (!CONTENT_TYPES.has(input.contentType)) throw new ServiceError('invalid-input', 'Attachment type is not allowed');
    try {
      const attachment = doc(collection(db, 'conversations', input.conversationId, 'attachments'));
      const storagePath = `users/${uid}/conversations/${input.conversationId}/attachments/${attachment.id}/${safeName(input.fileName)}`;
      await setDoc(attachment, {
        ownerUid: uid,
        conversationId: input.conversationId,
        storagePath,
        fileName: safeName(input.fileName),
        contentType: input.contentType,
        sizeBytes: input.sizeBytes,
        generation: null,
        createdAt: serverTimestamp(),
        status: 'uploading',
        schemaVersion: 1,
      });
      return { attachmentId: asAttachmentId(attachment.id), storagePath };
    } catch (error) {
      throw mapFirestoreError(error);
    }
  }

  async upload(target: UploadTarget, file: Blob): Promise<Attachment> {
    const uid = requireUid(auth.currentUser?.uid);
    if (file.size > MAX_SIZE) throw new ServiceError('invalid-input', 'Attachment is too large');
    try {
      const storageReference = ref(storage, target.storagePath);
      const result = await uploadBytes(storageReference, file, { contentType: file.type });
      const url = await getDownloadURL(result.ref);
      const conversationId = target.storagePath.split('/')[3];
      await updateDoc(doc(db, 'conversations', conversationId, 'attachments', target.attachmentId), {
        status: 'ready',
        generation: result.metadata.generation ?? null,
      });
      return {
        id: target.attachmentId,
        ownerUid: uid as AttachmentDocument['ownerUid'],
        conversationId: conversationId as AttachmentDocument['conversationId'],
        storagePath: target.storagePath,
        fileName: target.storagePath.split('/').at(-1) ?? 'file',
        contentType: file.type,
        sizeBytes: file.size,
        generation: result.metadata.generation ?? null,
        createdAt: Timestamp.now(),
        status: 'ready',
        schemaVersion: 1,
        downloadUrl: url,
      };
    } catch (error) {
      throw mapFirestoreError(error);
    }
  }

  async remove(conversationId: string, attachmentId: string, storagePath: string): Promise<void> {
    requireUid(auth.currentUser?.uid);
    try {
      await deleteObject(ref(storage, storagePath));
      // The metadata document is intentionally deleted only by the trusted lifecycle path.
      void conversationId;
      void attachmentId;
    } catch (error) {
      throw mapFirestoreError(error);
    }
  }
}

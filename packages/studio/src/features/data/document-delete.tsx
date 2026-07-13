import type { DocumentReference } from 'pyric/firestore';
import type { FirestoreApi } from '@pyric/ui/firestore';
import type { RecursiveDeleteImpl } from '@pyric/ui/firestore/hooks';
import type { ConfirmFn } from '@pyric/ui/primitives';
import { deleteRecursively } from './recursiveDelete.js';

/** One document-delete contract for every Studio entry point: modal confirm,
 *  non-recursive by default, explicit opt-in for descendant deletion. */
export async function confirmDocumentDelete({
  confirm,
  ref,
  api,
  recursiveImpl,
}: {
  confirm: ConfirmFn;
  ref: DocumentReference;
  api: FirestoreApi;
  recursiveImpl: RecursiveDeleteImpl;
}): Promise<boolean> {
  let recursive = false;
  const ok = await confirm({
    title: `Delete document "${ref.id}"?`,
    body: (
      <label className="fs-delete-recursive">
        <input
          type="checkbox"
          onChange={(event) => {
            recursive = event.currentTarget.checked;
          }}
        />
        <span>Also delete subcollections recursively. Leave this off to keep nested data.</span>
      </label>
    ),
    destructive: true,
    confirmLabel: 'Delete document',
  });
  if (!ok) return false;
  if (recursive) await deleteRecursively(recursiveImpl, ref);
  else await api.deleteDoc(ref);
  return true;
}

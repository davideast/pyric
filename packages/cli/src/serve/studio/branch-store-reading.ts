/**
 * The branch store, read for the workspace port.
 *
 * The on-disk shape of a branch is stated once, in
 * `pyric/sandbox/branches/store`, and read there: the manifest and its format
 * tag, the forked base and the branch's current state one file per service,
 * the event log, and the candidate rules file. This module is the one place the
 * serve process asks that store what the project holds, and it hands the port a
 * branch that is already rebuilt: what the manifest recorded, the Firestore
 * documents the branch holds once its events have been applied, and any Storage
 * objects summarized strictly by SHA-256 byte reference (never inline base64).
 */
import { createHash } from 'node:crypto';
import {
  captureFullState,
  holdsBytesInline,
  type StorageObjectState,
} from 'pyric/sandbox';
import { listBranches, loadBranch } from 'pyric/sandbox/branches/store';

import type {
  WorkspaceBranch,
  WorkspaceBranchStorageReference,
} from './store-types.js';

interface RebuiltBranchSlice {
  documents: Record<string, Record<string, unknown>>;
  storage: WorkspaceBranchStorageReference[];
}

function summarizeStorageReference(
  object: StorageObjectState,
): WorkspaceBranchStorageReference {
  let sha256: string;
  let size: number;
  if (holdsBytesInline(object)) {
    const decoded = Buffer.from(object.contentBase64, 'base64');
    sha256 = createHash('sha256').update(decoded).digest('hex');
    size = decoded.byteLength;
  } else {
    sha256 = object.sha256;
    size = object.size;
  }
  const summary: WorkspaceBranchStorageReference = {
    path: object.path,
    sha256,
    size,
    customMetadata: { ...object.customMetadata },
  };
  if (object.bucket !== undefined) summary.bucket = object.bucket;
  if (object.contentType !== undefined) summary.contentType = object.contentType;
  if (object.blobType !== undefined) summary.blobType = object.blobType;
  return summary;
}

/** Every branch the project holds, ordered by name, each one rebuilt. */
export async function readBranches(projectDir: string): Promise<WorkspaceBranch[]> {
  const rebuilt: WorkspaceBranch[] = [];
  for (const entry of listBranches(projectDir)) {
    const slice = await rebuiltSliceOf(projectDir, entry.name);
    const branchSummary: WorkspaceBranch = {
      name: entry.name,
      created: entry.created,
      base: entry.base,
      eventCount: entry.eventCount,
      documents: slice.documents,
    };
    if (slice.storage.length > 0) {
      branchSummary.storage = slice.storage;
    }
    rebuilt.push(branchSummary);
  }
  return rebuilt;
}

/**
 * The Firestore documents and SHA-256 Storage references one branch holds. A
 * branch that will not rebuild reports empty slices rather than failing the
 * listing, so one unreadable branch does not take the whole panel down.
 */
async function rebuiltSliceOf(
  projectDir: string,
  name: string,
): Promise<RebuiltBranchSlice> {
  try {
    const loaded = await loadBranch(projectDir, name);
    if (loaded === null) return { documents: {}, storage: [] };
    try {
      const documents = loaded.branch.sandbox.snapshot().firestore;
      const fullState = await captureFullState(loaded.branch.sandbox);
      const storage = fullState.storage.map(summarizeStorageReference);
      return { documents, storage };
    } finally {
      loaded.branch.sandbox.dispose();
    }
  } catch (error) {
    // Isolate corrupt branch state files/JSON so valid sibling branches still render.
    if (error instanceof Error) {
      return { documents: {}, storage: [] };
    }
    throw error;
  }
}

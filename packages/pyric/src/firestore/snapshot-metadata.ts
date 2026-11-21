import { SnapshotMetadata } from './types.js';

export type SnapshotMetadataInstance = SnapshotMetadata & {
  isEqual(other: SnapshotMetadata): boolean;
};

function snapshotMetadataIsEqual(this: SnapshotMetadata, other: SnapshotMetadata): boolean {
  if (other === null || typeof other !== 'object') {
    return false;
  }
  return (
    this.hasPendingWrites === other.hasPendingWrites
    && this.fromCache === other.fromCache
  );
}

Object.defineProperty(SnapshotMetadata.prototype, 'isEqual', {
  value: snapshotMetadataIsEqual,
  configurable: true,
  writable: true,
});

/**
 * Builds an immutable `SnapshotMetadata` value whose prototype inherits from
 * `SnapshotMetadata.prototype` and exposes `isEqual(other)` matching
 * `@firebase/firestore` (`hasPendingWrites` and `fromCache` equality).
 */
export function createSnapshotMetadata(
  fromCache: boolean,
  hasPendingWrites: boolean,
): SnapshotMetadataInstance {
  const metadata = Object.create(SnapshotMetadata.prototype) as {
    fromCache: boolean;
    hasPendingWrites: boolean;
  };
  metadata.fromCache = Boolean(fromCache);
  metadata.hasPendingWrites = Boolean(hasPendingWrites);
  return Object.freeze(metadata) as SnapshotMetadataInstance;
}

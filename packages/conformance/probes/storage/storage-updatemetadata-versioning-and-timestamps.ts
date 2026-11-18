import type { Probe } from '../../rigs/types.ts';
import { withStorageProbeSession } from '../../src/storage-probe-session.ts';

interface VersioningSnapshot {
  generation: string;
  metageneration: string;
  timeCreated: string;
  updated: string;
}

export interface StorageUpdateMetadataVersioningSubject {
  uploadAndUpdateTwice(subpath: string): Promise<{
    initial: VersioningSnapshot;
    firstUpdate: VersioningSnapshot;
    secondUpdate: VersioningSnapshot;
  }>;
}

function isValidIsoTimestamp(value: string): boolean {
  return value.length > 0 && Number.isFinite(Date.parse(value));
}

export async function observeUpdateMetadataVersioningAndTimestamps(
  subject: StorageUpdateMetadataVersioningSubject,
): Promise<Record<string, unknown>> {
  const { initial, firstUpdate, secondUpdate } = await subject.uploadAndUpdateTwice(
    'updatemetadata-versioning/item.bin',
  );

  const initialCreatedMs = Date.parse(initial.timeCreated);
  const initialUpdatedMs = Date.parse(initial.updated);
  const firstUpdatedMs = Date.parse(firstUpdate.updated);
  const secondUpdatedMs = Date.parse(secondUpdate.updated);

  return {
    initialMetageneration: initial.metageneration,
    firstUpdateMetageneration: firstUpdate.metageneration,
    secondUpdateMetageneration: secondUpdate.metageneration,
    generationIsDigits: /^\d+$/.test(initial.generation),
    generationPinnedAcrossUpdates:
      firstUpdate.generation === initial.generation &&
      secondUpdate.generation === initial.generation,
    timeCreatedPinnedAcrossUpdates:
      firstUpdate.timeCreated === initial.timeCreated &&
      secondUpdate.timeCreated === initial.timeCreated,
    isoTimestampsValid:
      isValidIsoTimestamp(initial.timeCreated) &&
      isValidIsoTimestamp(initial.updated) &&
      isValidIsoTimestamp(firstUpdate.updated) &&
      isValidIsoTimestamp(secondUpdate.updated),
    firstUpdatedNotBeforeTimeCreated: firstUpdatedMs >= initialCreatedMs,
    firstUpdatedNotBeforeInitialUpdated: firstUpdatedMs >= initialUpdatedMs,
    secondUpdatedStrictlyAfterInitialUpdated: secondUpdatedMs > initialUpdatedMs,
    secondUpdatedNotBeforeFirstUpdated: secondUpdatedMs >= firstUpdatedMs,
  };
}

export const probe: Probe = {
  rig: 'sdk-probes',
  requires: ['web-config'],
  pendingRowLink: true,
  matrixRow: '',
  rowIds: [],
  description:
    'updateMetadata(ref, patch) versioning and timestamps: observes +1 metageneration increments across consecutive updates, pinned generation and timeCreated, and advancing updated timestamps.',
  async observe() {
    return withStorageProbeSession(async ({ objectRef, storageSdk }) => {
      return observeUpdateMetadataVersioningAndTimestamps({
        async uploadAndUpdateTwice(subpath) {
          const targetRef = objectRef(subpath);
          const uploaded = await storageSdk.uploadBytes(
            targetRef,
            new Uint8Array([0x01, 0x02, 0x03, 0x04]),
            { contentType: 'text/plain' },
          );

          await new Promise((resolve) => setTimeout(resolve, 40));
          const first = await storageSdk.updateMetadata(targetRef, {
            customMetadata: { step: '1' },
          });

          await new Promise((resolve) => setTimeout(resolve, 40));
          const second = await storageSdk.updateMetadata(targetRef, {
            customMetadata: { step: '2' },
          });

          return {
            initial: {
              generation: uploaded.metadata.generation,
              metageneration: uploaded.metadata.metageneration,
              timeCreated: uploaded.metadata.timeCreated,
              updated: uploaded.metadata.updated,
            },
            firstUpdate: {
              generation: first.generation,
              metageneration: first.metageneration,
              timeCreated: first.timeCreated,
              updated: first.updated,
            },
            secondUpdate: {
              generation: second.generation,
              metageneration: second.metageneration,
              timeCreated: second.timeCreated,
              updated: second.updated,
            },
          };
        },
      });
    });
  },
};

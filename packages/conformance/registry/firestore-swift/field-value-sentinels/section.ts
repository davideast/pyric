import { defineRowSection } from '../../section-rows.ts';
import { bindSwiftFirestoreRow } from '../defaults.ts';

export const section = defineRowSection({
  surface: 'firestore-swift',
  order: 80,
  defaults: {
    section: '`FieldValue` \u2014 sentinels & transformations',
  },
});

export const row = bindSwiftFirestoreRow(section);

export const LIVE_HOST_TYPES_SUITE =
  'packages/swift-client/Tests/PyricLiveHostTests/FirestoreTypesLiveHostConformanceTests.swift';

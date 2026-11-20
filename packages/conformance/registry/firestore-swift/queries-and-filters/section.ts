import { defineRowSection } from '../../section-rows.ts';
import { bindSwiftFirestoreRow } from '../defaults.ts';

export const section = defineRowSection({
  surface: 'firestore-swift',
  order: 40,
  defaults: {
    section: '`Query` \u2014 filters & constraints',
  },
});

export const row = bindSwiftFirestoreRow(section);

export const LIVE_HOST_QUERIES_SUITE =
  'packages/swift-client/Tests/PyricLiveHostTests/FirestoreQueriesLiveHostConformanceTests.swift';

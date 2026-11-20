import { row } from './section.ts';

export default row({
  order: 40,
  api: 'DatabaseReference.key',
  behavior: 'Returns the last path segment token of the reference, or nil for the root reference.',
  featureKeys: ['key'],
});

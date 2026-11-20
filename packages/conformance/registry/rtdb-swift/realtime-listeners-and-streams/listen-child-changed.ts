import { row } from './section.ts';

export default row({
  order: 30,
  api: 'DatabaseQuery.observe(.childChanged) / childEvents',
  behavior: 'Emits childChanged event whenever an existing child node is modified.',
  featureKeys: ['observeChildChanged'],
});

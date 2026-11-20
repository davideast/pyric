import { row } from './section.ts';

export default row({
  order: 40,
  api: 'DatabaseQuery.observe(.childRemoved) / childEvents',
  behavior: 'Emits childRemoved event whenever a child node is removed from the watched location.',
  featureKeys: ['observeChildRemoved'],
});

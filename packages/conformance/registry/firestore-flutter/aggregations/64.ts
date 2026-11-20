import { row } from './section.ts';

export default row({
  order: 10,
  api: 'AggregateQueryPlatform.count()',
  behavior: 'Returns count of matched documents without pulling full document payloads.',
  featureKeys: ['count'],
  flipped: 'unit-backed',
});

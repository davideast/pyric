import { row } from './section.ts';

export default row({
  order: 80,
  api: 'Query.where(filter)',
  behavior: 'Evaluates composite boolean expressions constructed via Filter.and(...) or Filter.or(...).',
  featureKeys: ['where', 'filter'],
  flipped: 'unit-backed',
});

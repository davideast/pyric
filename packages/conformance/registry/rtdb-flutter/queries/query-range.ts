import { row } from './section.ts';

export default row({
  order: 50,
  api: 'Query.startAt(value) / endAt(value)',
  behavior: 'Restricts query results to the inclusive lower and upper boundary values.',
  featureKeys: ['startAt', 'endAt'],
});

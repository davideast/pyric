import { row } from './section.ts';

export default row({
  order: 60,
  api: 'Query.limitToFirst(limit) / limitToLast(limit)',
  behavior: 'Caps query results to the first N or last N ordered child nodes.',
  featureKeys: ['limitToFirst', 'limitToLast'],
});

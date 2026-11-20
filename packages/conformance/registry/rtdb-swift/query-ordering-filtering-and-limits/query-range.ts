import { row } from './section.ts';

export default row({
  order: 50,
  api: 'DatabaseQuery.queryStarting(atValue:) / queryEnding(atValue:)',
  behavior: 'Restricts query results to the inclusive lower and upper boundary values.',
  featureKeys: ['queryStartingAtValue', 'queryEndingAtValue'],
});

import { row } from './section.ts';

export default row({
  order: 50,
  api: 'Query.removeEventListener / Job.cancel()',
  behavior: 'Cancels the active listener or coroutine Flow collection and unsubscribes the worker listener.',
  featureKeys: ['removeEventListener'],
});

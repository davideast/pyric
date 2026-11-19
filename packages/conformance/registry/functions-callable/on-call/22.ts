import { row } from './section.ts';

export default row({
  order: 220,
  kind: 'pyric',
  api: 'firebase-admin inside onCall',
  behavior:
    'A firebase-admin write the handler awaits is visible to a page of the same sandbox before the call\'s result arrives.',
  evidence:
    'The child runs with PYRIC_SANDBOX=remote:<serveUrl> and pre-initializes the ambient firebase-admin app, as for functions-http#18. The fixture\'s admin-write mode writes `pyric_oracle_callable/{id}`.',
});

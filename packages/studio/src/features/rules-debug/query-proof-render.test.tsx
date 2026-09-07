import { expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { LocalEnvironment } from 'pyric/sandbox/internal';
import type { RequestEvent } from 'pyric/sandbox';
import { selectDenials } from './model.js';
import { DenialDetail } from './RulesDebug.js';

test('rendered proof failure labels primary status and residual evidence distinctly', () => {
  const env = new LocalEnvironment();
  try {
    env.seed({ rules: `rules_version = '2'; service cloud.firestore {
      match /databases/{database}/documents {
        match /meets/{id} { allow list: if resource.data.status in ['scheduled']; }
        match /{document=**} { allow read: if false; }
      }
    }`, documents: {} });
    const events: RequestEvent[] = [];
    env.onRequest(event => events.push(event));
    env.runQuery({scope: {kind: 'collection', path: 'meets'}, auth: null,
      execution: {filters: [{kind: 'where', field: 'status', op: '==', value: 'scheduled'}], orders: [], limitFromEnd: false}});
    const [denial] = selectDenials(JSON.parse(JSON.stringify(events)));
    const html = renderToStaticMarkup(<DenialDetail denial={denial!} />);
    expect(html.match(/data-pyric-badge=""[^>]*>([^<]*)</)?.[1]).toBe('Query proof unsupported');
    expect(html).toContain('This does not establish Firebase');
    expect(html).toContain('residual evaluation — separate from the static proof');
    expect(denial?.evaluatedRule?.expression).toBe('false');
    const ordinary = {...denial!, queryProof: undefined};
    const ordinaryHtml = renderToStaticMarkup(<DenialDetail denial={ordinary} />);
    expect(ordinaryHtml.match(/data-pyric-badge=""[^>]*>([^<]*)</)?.[1]).toBe('denied');
    const allowedHtml = renderToStaticMarkup(<DenialDetail denial={{...ordinary, result: 'allow'}} />);
    expect(allowedHtml.match(/data-pyric-badge=""[^>]*>([^<]*)</)?.[1]).toBe('allowed');
  } finally { env.dispose(); }
});

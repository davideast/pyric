/**
 * ─── Scenario: list-and-string-methods ────────────────────────────────────────
 * The everyday string- and list-manipulation surface used in field validation:
 * String.split/lower/upper/trim/replace/size and List.hasAll/hasAny/hasOnly/join,
 * plus Map.values(). A `posts` document whose `categories` is a comma-separated
 * string constrained by list-membership, with slug/title/code normalization
 * checks. Exercises the methods against production so the sandbox simulator's
 * string/list library is verdict-checked, not merely assumed.
 */
import type { ScenarioRecord } from './types.ts';

export const scenario: ScenarioRecord = {
  fm: 'Coverage: String + List methods',
  rationale:
    'Production must accept String.split/lower/upper/trim/replace/size, List.hasAll/hasAny/hasOnly/join and Map.values() in field-validation conditions.',
  rules: `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /posts/{postId} {
      allow create: if request.auth != null
        && request.resource.data.categories.split(',').hasOnly(['news', 'tech', 'sport'])
        && request.resource.data.categories.split(',').hasAny(['news', 'tech'])
        && request.resource.data.categories.split(',').hasAll(['news'])
        && request.resource.data.tags.join(',').size() > 0
        && request.resource.data.slug.lower() == request.resource.data.slug
        && request.resource.data.title.trim().size() >= 3
        && request.resource.data.code.upper().size() == 4
        && request.resource.data.body.replace('  ', ' ').size() > 0
        && request.resource.data.values().size() >= 5;
    }
  }
}`,
  cases: [
    {
      description: 'well-formed post ALLOW',
      expectation: 'ALLOW',
      method: 'create',
      path: 'posts/p1',
      auth: { uid: 'alice' },
      data: {
        categories: 'news,tech',
        tags: ['a', 'b'],
        slug: 'my-post',
        title: 'Title',
        code: 'abcd',
        body: 'some  body',
      },
    },
    {
      description: 'category outside allowed set DENY (split hasOnly)',
      expectation: 'DENY',
      method: 'create',
      path: 'posts/p2',
      auth: { uid: 'alice' },
      data: {
        categories: 'news,gossip',
        tags: ['a', 'b'],
        slug: 'my-post',
        title: 'Title',
        code: 'abcd',
        body: 'some  body',
      },
    },
    {
      description: 'slug not lowercase DENY (String.lower)',
      expectation: 'DENY',
      method: 'create',
      path: 'posts/p3',
      auth: { uid: 'alice' },
      data: {
        categories: 'news,tech',
        tags: ['a', 'b'],
        slug: 'My-Post',
        title: 'Title',
        code: 'abcd',
        body: 'some  body',
      },
    },
    {
      description: 'code wrong length after upper DENY (String.upper/size)',
      expectation: 'DENY',
      method: 'create',
      path: 'posts/p4',
      auth: { uid: 'alice' },
      data: {
        categories: 'news,tech',
        tags: ['a', 'b'],
        slug: 'my-post',
        title: 'Title',
        code: 'abc',
        body: 'some  body',
      },
    },
  ],
  group: 'stress',
};

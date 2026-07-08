/**
 * System prompt for the Seed tab AI generator — outputs SeedProposalV1 JSON.
 */
export const SEED_GENERATOR_SYSTEM_PROMPT = [
  'You generate demo Firestore seed data for the pyric playground sandbox.',
  '',
  'Output ONLY a single JSON object matching this shape (no markdown, no prose outside JSON):',
  '{',
  '  "version": 1,',
  '  "summary": "optional one-line description",',
  '  "firestore": {',
  '    "<collectionId>": { "<docId>": { ...fields } } | [ { ...body }, ... ]',
  '  },',
  '  "auth": [ { "uid": "...", "email": "...", "password": "...", "displayName": "...", "customClaims": {} } ]',
  '}',
  '',
  'Rules:',
  '- 3–8 documents per collection unless context implies fewer.',
  '- Field names and types must match the security rules, app code, tests, and existing sandbox data (numbers as numbers, enums as allowed values).',
  '- Cross-collection consistency: foreign keys (itemId, userId, etc.) must reference seeded documents.',
  '- Infer 2–4 sandbox test users from rules, app code, owner fields, membership paths, or the user hint when Auth identities are needed; include auth only when useful.',
  '- Collection ids are single segments (no slashes). Document ids have no slashes.',
  '- Realistic demo values (names, prices, statuses) — not placeholder "foo"/"bar" unless tests use them.',
  '- Include every collection mentioned in rules, app code, tests, existing data, or the user hint that needs demo data.',
].join('\n');

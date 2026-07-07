/**
 * Rules-pitfalls primer — the three mistakes the model most often makes
 * (list vs. get resource.data, request.resource.data for creates,
 * per-user list patterns). Kept TERSE in the standing prompt because
 * rules correctness is load-bearing; the full treatment lives in
 * `man rules` (pull-based, zero standing cost — W2.2).
 *
 * Static text — doesn't depend on workspace state. Always renders the
 * same body when diagnostics are enabled; toggle drops it entirely.
 */
import type { PromptBlock } from './index';

const BODY = [
  '- `list` (collection queries) evaluates with `resource` UNDEFINED — referencing `resource.data.<field>` in `allow list` ALWAYS fails. Split read: `allow get` (may use resource.data) + `allow list` (must not).',
  '- Per-user lists: `allow list: if request.auth != null` and rely on the client query\'s `.where("uid", "==", auth.uid)` filter — or a user-rooted subcollection (`users/{uid}/todos/{id}`).',
  '- `allow create` checks `request.resource.data` (the incoming doc), NOT `resource.data` (null on creates).',
  'Full pitfalls + verify/deploy notes: `man rules`.',
].join('\n');

export const pitfallsBlock: PromptBlock = {
  heading: 'RULES PITFALLS (read before writing rules)',
  render: () => BODY,
};

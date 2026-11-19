import { row } from './section.ts';

export default row({
  order: 20,
  featureKeys: ["getRedirectResult"],
  behavior: "`getRedirectResult(auth)` returns the stashed credential once, then `null` (one-shot, matches prod)",
  rowNumber: 49,
});

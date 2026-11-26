import {sample} from '../../reference/fixtures.mjs';

// A controlled SDK proposal changes just the claimed successor castling rights.
// All other fields, including previous rights, use the standard frozen adapter.
export function sampleRights(c,writer,other) {
  const {before,proposal}=sample(c,writer,other);
  return {before,proposal:{...proposal,castling:c.claimedRights}};
}

import { it } from 'bun:test';
import { scenario } from '../../../../conformance/src/capture/sdk-scenarios/firestore/firestore-delete-then-update-same-commit.scenario.ts';
import { expectReplay, load, runInPage, withoutMessages } from './support.ts';

// FW-19 was refuted by this capture: production refuses delete then update
// with invalid-argument too, and leaves the doc unchanged. Only the text differs.
it('firestore-delete-then-update-same-commit', async () => {
  const production = withoutMessages(load('firestore-delete-then-update-same-commit'));
  const pyric = withoutMessages(await runInPage(scenario));
  expectReplay({ production, pyric });
});

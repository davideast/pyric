import { describe, expect, it } from 'bun:test';
import { allCompatibilityRows } from '../../../../conformance/registry/index.ts';
import { loadObservations } from '../../../../conformance/observations/load.ts';
import { loadPendingRowLinkObservations } from '../../../../conformance/src/staged-captures.ts';
import {
  auditObservationCompleteness,
  discoverCddAssertionRowIds,
  type ObservationCompletenessInput,
} from './observation-completeness.js';

const NOT_APPLICABLE: Readonly<Record<string, string>> = {
  'rtdb-modular-admin-connection-and-ondisconnect':
    'Pure `rtdb-admin` capture (`rtdb-admin#6`, `firebase-admin/database` `goOffline`/`goOnline` and `Reference#onDisconnect`); replayed across in-process, remote, SharedWorker, and Node host planes in `packages/pyric-admin/test/database/capture-admin-database-and-priorities.test.ts` and `packages/cli/test/serve/worker/oracle-captures/rtdb-admin-database-and-priorities.test.ts`.',
  'rtdb-modular-admin-priorities-and-inline-priority':
    'Pure `rtdb-admin` capture (`rtdb-admin#7`, `firebase-admin/database` `Reference#setPriority`, `Reference#setWithPriority`, and inline `.priority`); replayed across all four admin planes in `packages/pyric-admin/test/database/capture-admin-database-and-priorities.test.ts` and `packages/cli/test/serve/worker/oracle-captures/rtdb-admin-database-and-priorities.test.ts`.',
  'rtdb-modular-admin-query-bounds-listeners-and-context':
    'Pure `rtdb-admin` capture (`rtdb-admin#5`, `firebase-admin/database` `Query` ordering, bounds, limits, context binding, scoped `off()`, and windowed `child_*` events); replayed across all four admin planes in `packages/pyric-admin/test/database/capture-admin-query-bounds-listeners-and-context.test.ts` and `packages/cli/test/serve/worker/oracle-captures/rtdb-admin-query-bounds-listeners-and-context.test.ts`.',
  'rtdb-modular-admin-ref-navigation-and-url-errors':
    'Pure `rtdb-admin` capture (`rtdb-admin#2`, `firebase-admin/database` `Database#ref`, `refFromURL`, and `Reference` navigation); replayed across all four admin planes in `packages/pyric-admin/test/database/capture-admin-database-and-priorities.test.ts` and `packages/cli/test/serve/worker/oracle-captures/rtdb-admin-database-and-priorities.test.ts`.',
  'rtdb-modular-admin-transaction-rules-and-logging':
    'Pure `rtdb-admin` capture (`rtdb-admin#8`, `firebase-admin/database` `Reference#transaction`, `Database#getRules`/`getRulesJSON`/`setRules`, and `enableLogging`); replayed across all four admin planes in `packages/pyric-admin/test/database/capture-admin-transaction-rules-and-logging.test.ts` and `packages/cli/test/serve/worker/oracle-captures/rtdb-admin-transaction-rules-and-logging.test.ts`.',
  'rtdb-modular-admin-use-emulator-validation':
    'Pure `rtdb-admin` capture (`rtdb-admin#9`, `firebase-admin/database` `Database#useEmulator(host, port)` pre-start URL rebinding, custom-host `refFromURL`, post-start idempotency, and fatal guards); replayed across all four admin planes in `packages/pyric-admin/test/database/capture-admin-use-emulator.test.ts` and `packages/cli/test/serve/worker/oracle-captures/rtdb-admin-use-emulator.test.ts`.',
  'rtdb-modular-admin-writes-sentinels-and-validation':
    'Pure `rtdb-admin` capture (`rtdb-admin#3`, `firebase-admin/database` `Reference` writes, `ServerValue`, and synchronous validation); replayed across all four admin planes in `packages/pyric-admin/test/database/capture-admin-database-and-priorities.test.ts` and `packages/cli/test/serve/worker/oracle-captures/rtdb-admin-database-and-priorities.test.ts`.',
};

describe('rtdb-modular CDD observation completeness', () => {
  it('fails closed when a committed observation has no joined CDD row', () => {
    const input: ObservationCompletenessInput = {
      observations: [{ name: 'rtdb-modular-new-capture', rowIds: ['rtdb-modular#999'] }],
      rows: [],
      assertedRowIds: [],
      notApplicable: {},
    };

    expect(auditObservationCompleteness(input).uncovered).toEqual([
      'rtdb-modular-new-capture',
    ]);
  });

  it('exempts unlinked pendingRowLink staged observations while failing on linked or non-staged uncovered observations', () => {
    const pendingRowLinkStems = new Set([
      'rtdb-modular-staged-unlinked',
      'rtdb-modular-staged-linked',
    ]);

    const stagedOnly: ObservationCompletenessInput = {
      observations: [{ name: 'rtdb-modular-staged-unlinked', rowIds: [] }],
      rows: [],
      assertedRowIds: [],
      notApplicable: {},
      pendingRowLinkStems,
    };
    expect(auditObservationCompleteness(stagedOnly).uncovered).toEqual([]);

    const mixedUncovered: ObservationCompletenessInput = {
      observations: [
        { name: 'rtdb-modular-staged-unlinked', rowIds: [] },
        { name: 'rtdb-modular-non-staged-unlinked', rowIds: [] },
        { name: 'rtdb-modular-staged-linked', rowIds: ['rtdb-modular#999'] },
      ],
      rows: [],
      assertedRowIds: [],
      notApplicable: {},
      pendingRowLinkStems,
    };
    expect(auditObservationCompleteness(mixedUncovered).uncovered).toEqual([
      'rtdb-modular-non-staged-unlinked',
      'rtdb-modular-staged-linked',
    ]);
  });

  it('requires explicit NOT_APPLICABLE entries to name a capture and explain why', () => {
    const input: ObservationCompletenessInput = {
      observations: [{ name: 'rtdb-modular-covered', rowIds: [] }],
      rows: [],
      assertedRowIds: [],
      notApplicable: {
        'rtdb-modular-covered': '   ',
        'rtdb-modular-missing': 'not in the committed corpus',
      },
    };

    expect(auditObservationCompleteness(input).invalidNotApplicable).toEqual([
      'rtdb-modular-covered: reason is empty',
      'rtdb-modular-missing: no committed observation',
    ]);
  });

  it('joins every committed observation to a row-keyed CDD assertion or an explicit reason', () => {
    const result = auditObservationCompleteness({
      observations: loadObservations().filter(({ surfaceDir }) => surfaceDir === 'rtdb-modular'),
      rows: allCompatibilityRows.filter(({ surface }) => surface === 'rtdb-modular'),
      assertedRowIds: discoverCddAssertionRowIds(import.meta.dir),
      notApplicable: NOT_APPLICABLE,
      pendingRowLinkStems: loadPendingRowLinkObservations(),
    });

    expect(result).toEqual({
      uncovered: [],
      duplicateAssertions: [],
      invalidNotApplicable: [],
      staleCitations: [],
      unassertedRows: [],
      unknownAssertions: [],
    });
  });
});

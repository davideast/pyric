import { rpcMessage } from './rpc-message.mjs';
import { storeClient } from './store-client.mjs';
import { claimExpired, selectDueCandidates } from '../architecture/recovery-claim.mjs';
import { reconcile } from '../architecture/reconcile.mjs';

const { store, call } = storeClient();
const owner = process.argv[2];

process.on('disconnect', () => process.exit(0));

process.on('message', async raw => {
    const message = rpcMessage(raw);
    if (!message || message.type !== 'command') return;

    const { id, operation, request, now: nowMs, policies, limits, budget, fence, evidence: suppliedEvidence } = message;
    const now = () => nowMs;
    const context = (req, phase = 'recovery') => ({
        requestId:  req?.requestId ?? null,
        instanceId: owner,
        uid:        req?.uid ?? null,
        phase,
    });

    try {
        let value;

        if (operation === 'claim') {
            value = await claimExpired(store, request, { owner, now, leaseMs: budget.leaseMs }, context(request, 'claim'));
        } else if (operation === 'reconcile') {
            const ev = suppliedEvidence ?? await call('provider-observe', { key: request.providerKey });
            value = await reconcile(store, request, fence, ev, { policies, limits, budget, now }, context(request, 'reconcile'));
        } else if (operation === 'sweep') {
            // Autonomous cursor-paginated sweep across all due pages
            let cursor = null;
            let pagesScanned = 0;
            let candidatesScanned = 0;
            let claimedCount = 0;
            let skippedCount = 0;
            const actions = [];

            while (pagesScanned < budget.maxScanPages) {
                pagesScanned++;
                const allRecords = await store.listRequests();
                const { page, nextCursor } = selectDueCandidates(allRecords, {
                    now:      nowMs,
                    pageSize: budget.pageSize,
                    cursor,
                });

                if (page.length === 0) break;
                candidatesScanned += page.length;

                for (const candidate of page) {
                    const req = {
                        uid:         candidate.uid,
                        requestId:   candidate.requestId,
                        category:    candidate.category,
                        providerKey: candidate.providerKey,
                    };
                    const claim = await claimExpired(store, req, { owner, now, leaseMs: budget.leaseMs }, context(req, 'claim'));
                    if (claim.status !== 'claimed') {
                        skippedCount++;
                        actions.push({ requestId: req.requestId, status: claim.status });
                        continue;
                    }
                    claimedCount++;
                    let ev = null;
                    if (claim.record.state !== 'reserved') {
                        ev = await call('provider-observe', { key: claim.record.providerKey });
                    }
                    const outcome = await reconcile(
                        store,
                        req,
                        claim.record.fence,
                        ev,
                        { policies, limits, budget, now },
                        context(req, 'reconcile'),
                    );
                    actions.push({
                        requestId: req.requestId,
                        fence:     claim.record.fence,
                        action:    outcome.action,
                        state:     outcome.record?.state,
                    });
                }

                if (!nextCursor) break;
                cursor = nextCursor;
            }

            value = {
                owner,
                pagesScanned,
                candidatesScanned,
                claimed: claimedCount,
                skipped: skippedCount,
                actions,
            };
        } else {
            throw Object.assign(new Error('unsupported-command'), { code: 'unsupported-command' });
        }

        process.send({ type: 'command-result', id, value });
    } catch (error) {
        process.send({ type: 'command-result', id, error: error.code ?? error.message });
    }
});

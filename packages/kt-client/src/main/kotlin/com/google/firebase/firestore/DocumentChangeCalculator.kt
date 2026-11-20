package com.google.firebase.firestore

internal object DocumentChangeCalculator {

    fun initialChanges(documents: List<QueryDocumentSnapshot>): List<DocumentChange> =
        documents.mapIndexed { index, doc ->
            DocumentChange(
                type = DocumentChange.Type.ADDED,
                document = doc,
                oldIndex = -1,
                newIndex = index
            )
        }

    /**
     * Computes sequential [DocumentChange] transitions (REMOVED, ADDED, MODIFIED) that
     * transform [previousDocs] into [currentDocs] in step-by-step adapter order.
     */
    fun computeChanges(
        previousDocs: List<QueryDocumentSnapshot>?,
        currentDocs: List<QueryDocumentSnapshot>,
        includeMetadataChanges: Boolean
    ): List<DocumentChange> {
        if (previousDocs == null) {
            return initialChanges(currentDocs)
        }

        val prevByPath = previousDocs.associateBy { it.reference.path }
        val nextByPath = currentDocs.associateBy { it.reference.path }
        val nextRank = currentDocs.withIndex().associate { (idx, doc) -> doc.reference.path to idx }

        val working = previousDocs.map { it.reference.path }.toMutableList()
        val changes = mutableListOf<DocumentChange>()

        // 1. REMOVED: in previous order, tracking sequential working index.
        for (prevDoc in previousDocs) {
            val path = prevDoc.reference.path
            if (!nextByPath.containsKey(path)) {
                val oldIdx = working.indexOf(path)
                working.removeAt(oldIdx)
                val removedSnap = if (prevDoc.metadata.hasPendingWrites && !prevDoc.metadata.isFromCache) {
                    QueryDocumentSnapshot(
                        id = prevDoc.id,
                        reference = prevDoc.reference,
                        dataMap = prevDoc.rawMapSnapshot(),
                        metadata = SnapshotMetadata(hasPendingWrites = false, isFromCache = false)
                    )
                } else {
                    prevDoc
                }
                changes.add(
                    DocumentChange(
                        type = DocumentChange.Type.REMOVED,
                        document = removedSnap,
                        oldIndex = oldIdx,
                        newIndex = -1
                    )
                )
            }
        }

        // Partition surviving paths into a strictly increasing stationary backbone (prioritizing
        // unchanged docs, which preserve relative order) and paths whose sort position moved.
        val stationary = computeStationaryPaths(working, nextRank, prevByPath, nextByPath)
        val moving = working.filterTo(HashSet()) { it !in stationary }

        // 2. ADDED: insert new documents relative to the stationary backbone in target order.
        for (nextDoc in currentDocs) {
            val path = nextDoc.reference.path
            if (!prevByPath.containsKey(path)) {
                val targetRank = nextRank.getValue(path)
                val insertIdx = working.indexOfLast {
                    it in stationary && nextRank.getValue(it) < targetRank
                } + 1
                working.add(insertIdx, path)
                stationary.add(path)
                changes.add(
                    DocumentChange(
                        type = DocumentChange.Type.ADDED,
                        document = nextDoc,
                        oldIndex = -1,
                        newIndex = insertIdx
                    )
                )
            }
        }

        // 3. MODIFIED: reposition moved documents and report in-place data/metadata updates.
        for (nextDoc in currentDocs) {
            val path = nextDoc.reference.path
            val prevDoc = prevByPath[path] ?: continue
            val dataChanged = prevDoc.rawMapSnapshot() != nextDoc.rawMapSnapshot()
            val metadataChanged = prevDoc.metadata != nextDoc.metadata
            val moved = path in moving

            if (moved) {
                val oldIdx = working.indexOf(path)
                working.removeAt(oldIdx)
                val targetRank = nextRank.getValue(path)
                val newIdx = working.indexOfLast {
                    it in stationary && nextRank.getValue(it) < targetRank
                } + 1
                working.add(newIdx, path)
                moving.remove(path)
                stationary.add(path)
                changes.add(
                    DocumentChange(
                        type = DocumentChange.Type.MODIFIED,
                        document = nextDoc,
                        oldIndex = oldIdx,
                        newIndex = newIdx
                    )
                )
            } else if (dataChanged || (includeMetadataChanges && metadataChanged)) {
                val idx = working.indexOf(path)
                changes.add(
                    DocumentChange(
                        type = DocumentChange.Type.MODIFIED,
                        document = nextDoc,
                        oldIndex = idx,
                        newIndex = idx
                    )
                )
            }
        }

        return changes
    }

    /**
     * Computes a maximum-weight increasing subsequence over [surviving] ordered by [nextRank],
     * giving unchanged documents priority over modified documents so unchanged documents stay
     * stationary whenever a modified document crosses past them.
     */
    private fun computeStationaryPaths(
        surviving: List<String>,
        nextRank: Map<String, Int>,
        prevByPath: Map<String, QueryDocumentSnapshot>,
        nextByPath: Map<String, QueryDocumentSnapshot>
    ): MutableSet<String> {
        val n = surviving.size
        if (n == 0) return HashSet()
        val bonus = n + 1
        val weights = IntArray(n) { i ->
            val p = surviving[i]
            val unchanged = prevByPath.getValue(p).rawMapSnapshot() == nextByPath.getValue(p).rawMapSnapshot()
            if (unchanged) bonus else 1
        }
        val dp = IntArray(n)
        val prev = IntArray(n) { -1 }
        var bestEnd = 0
        for (i in 0 until n) {
            dp[i] = weights[i]
            val rankI = nextRank.getValue(surviving[i])
            for (j in 0 until i) {
                if (nextRank.getValue(surviving[j]) < rankI && dp[j] + weights[i] > dp[i]) {
                    dp[i] = dp[j] + weights[i]
                    prev[i] = j
                }
            }
            if (dp[i] > dp[bestEnd]) {
                bestEnd = i
            }
        }
        val stationary = HashSet<String>()
        var curr = bestEnd
        while (curr != -1) {
            stationary.add(surviving[curr])
            curr = prev[curr]
        }
        return stationary
    }
}

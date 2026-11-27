package dev.pyric.bridge

import com.google.firebase.firestore.FirebaseFirestoreException
import dev.pyric.codecs.JsonCodec
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.runTest
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test

@OptIn(ExperimentalCoroutinesApi::class)
class StorageDenialEmissionTest {
    @Test
    fun emitsOnDenialForStorageUnauthorizedErrors() = runTest {
        val recorded = mutableListOf<FirebaseFirestoreException>()
        val dispatcher = BridgeOperationDispatcher(
            scope = this,
            onDenial = { recorded.add(it) }
        )
        val sentFrames = mutableListOf<String>()
        val deferred = dispatcher.startOp(
            method = "storage.uploadBytes",
            params = mapOf("path" to "uploads/test.bin"),
            timeoutMs = 5_000L,
            sendJson = { frame -> sentFrames.add(frame) },
            jsonSerializer = { JsonCodec.encodeToString(it) }
        )
        val opId = Regex("\"id\"\\s*:\\s*\"([^\"]+)\"").find(sentFrames.single())!!.groupValues[1]

        dispatcher.handleWorkerRes(
            mapOf(
                "type" to "worker-res",
                "id" to opId,
                "ok" to false,
                "error" to mapOf(
                    "code" to "storage/unauthorized",
                    "message" to "Storage write denied by rules."
                )
            ),
            wireSeq = 1L
        )

        assertTrue(deferred.isCancelled || deferred.getCompletionExceptionOrNull() != null)
        assertEquals(1, recorded.size)
        assertEquals("storage/unauthorized", recorded.single().wireCode)
    }

    @Test
    fun ignoresUnrelatedErrorsWithoutDenialContext() = runTest {
        val recorded = mutableListOf<FirebaseFirestoreException>()
        val dispatcher = BridgeOperationDispatcher(
            scope = this,
            onDenial = { recorded.add(it) }
        )
        val sentFrames = mutableListOf<String>()
        dispatcher.startOp(
            method = "storage.getBytes",
            params = mapOf("path" to "uploads/missing.bin"),
            timeoutMs = 5_000L,
            sendJson = { frame -> sentFrames.add(frame) },
            jsonSerializer = { JsonCodec.encodeToString(it) }
        )
        val opId = Regex("\"id\"\\s*:\\s*\"([^\"]+)\"").find(sentFrames.single())!!.groupValues[1]

        dispatcher.handleWorkerRes(
            mapOf(
                "type" to "worker-res",
                "id" to opId,
                "ok" to false,
                "error" to mapOf(
                    "code" to "storage/object-not-found",
                    "message" to "Missing object."
                )
            ),
            wireSeq = 2L
        )

        assertTrue(recorded.isEmpty())
    }

    @Test
    fun mergesTopLevelQueryProofAndReproIntoDenialContext() = runTest {
        val recorded = mutableListOf<FirebaseFirestoreException>()
        val dispatcher = BridgeOperationDispatcher(
            scope = this,
            onDenial = { recorded.add(it) }
        )
        val sentFrames = mutableListOf<String>()
        dispatcher.startOp(
            method = "getDocs",
            params = mapOf("path" to "publicItems"),
            timeoutMs = 5_000L,
            sendJson = { frame -> sentFrames.add(frame) },
            jsonSerializer = { JsonCodec.encodeToString(it) }
        )
        val opId = Regex("\"id\"\\s*:\\s*\"([^\"]+)\"").find(sentFrames.single())!!.groupValues[1]

        dispatcher.handleWorkerRes(
            mapOf(
                "type" to "worker-res",
                "id" to opId,
                "ok" to false,
                "error" to mapOf(
                    "code" to "permission-denied",
                    "message" to "list publicItems denied by rules",
                    "denialContext" to mapOf(
                        "reasons" to listOf("unprovable query")
                    ),
                    "queryProof" to mapOf(
                        "kind" to "constraints-not-satisfied",
                        "failures" to listOf(mapOf("kind" to "constraints-not-satisfied", "reason" to "missing filter"))
                    ),
                    "repro" to mapOf(
                        "command" to "pyric rules test --method list publicItems"
                    )
                )
            ),
            wireSeq = 3L
        )

        assertEquals(1, recorded.size)
        @Suppress("UNCHECKED_CAST")
        val ctx = recorded.single().denialContext as Map<String, Any?>
        assertTrue(ctx.containsKey("queryProof"))
        assertTrue(ctx.containsKey("repro"))
    }
}

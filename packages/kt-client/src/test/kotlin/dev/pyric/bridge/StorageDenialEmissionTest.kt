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
}

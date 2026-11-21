package dev.pyric.storage

import com.google.firebase.FirebaseApp
import com.google.firebase.FirebaseOptions
import com.google.firebase.appcheck.FirebaseAppCheck
import com.google.firebase.appcheck.debug.DebugAppCheckProviderFactory
import com.google.firebase.auth.FirebaseAuth
import com.google.firebase.storage.CancellableTask
import com.google.firebase.storage.ControllableTask
import com.google.firebase.storage.FirebaseStorage
import com.google.firebase.storage.OnProgressListener
import com.google.firebase.storage.StorageException
import com.google.firebase.storage.StorageMetadata
import com.google.firebase.storage.StorageTask
import com.google.firebase.storage.UploadTask
import dev.pyric.bridge.InMemoryBridgeTransport
import dev.pyric.bridge.PyricBridgeClient
import dev.pyric.codecs.JsonCodec
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.tasks.await as coroutinesAwait
import com.google.android.gms.tasks.await as gmsAwait
import org.junit.jupiter.api.AfterEach
import org.junit.jupiter.api.Assertions.assertArrayEquals
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Assertions.assertSame
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.BeforeEach
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.assertThrows
import java.util.concurrent.CancellationException
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.Executor
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicInteger

class StorageTaskAndTransferEdgeTest {

    private lateinit var harness: StorageMockBridgeHarness
    private lateinit var app: FirebaseApp
    private lateinit var storage: FirebaseStorage

    @BeforeEach
    fun setUp() {
        FirebaseStorage.clearInstancesForTest()
        FirebaseAuth.clearInstancesForTest()
        FirebaseAppCheck.clearInstancesForTest()
        FirebaseApp.clearInstancesForTest()

        harness = StorageMockBridgeHarness()
        val options = FirebaseOptions.Builder()
            .setProjectId("edge-proj")
            .setApiKey("edge-key")
            .setApplicationId("1:777:android:edge")
            .setStorageBucket("edge-proj.appspot.com")
            .build()
        app = FirebaseApp.initializeApp("edge-app", options)
        storage = FirebaseStorage.getInstance(app, harness.newBridgeClient())
    }

    @AfterEach
    fun tearDown() {
        harness.closeAll()
        FirebaseStorage.clearInstancesForTest()
        FirebaseAuth.clearInstancesForTest()
        FirebaseAppCheck.clearInstancesForTest()
        FirebaseApp.clearInstancesForTest()
    }

    @Test
    fun uploadTaskHierarchyExecutorListenersAndProgressRemovalMatchUpstream(): Unit = runBlocking {
        val ref = storage.getReference("uploads/listeners.bin")
        val directExecCount = AtomicInteger(0)
        val executor = Executor { runnable ->
            directExecCount.incrementAndGet()
            runnable.run()
        }

        val task = ref.putBytes(ByteArray(64) { 0x2A })
        assertTrue(StorageTask::class.java.isAssignableFrom(task.javaClass))
        assertTrue(ControllableTask::class.java.isAssignableFrom(task.javaClass))
        assertTrue(CancellableTask::class.java.isAssignableFrom(task.javaClass))

        val completedFlag = AtomicBoolean(false)
        val succeededBytes = AtomicInteger(0)
        val progressEvents = CopyOnWriteArrayList<Long>()
        val removableListener = OnProgressListener<UploadTask.TaskSnapshot> { snap ->
            progressEvents.add(snap.bytesTransferred)
        }

        task.addOnProgressListener(executor, removableListener)
        task.removeOnProgressListener(removableListener)
        task.addOnSuccessListener(executor) { snap ->
            succeededBytes.set(snap.bytesTransferred.toInt())
        }
        task.addOnCompleteListener(executor) { completed ->
            completedFlag.set(completed.isSuccessful)
            assertSame(ref, completed.result.storage)
            assertSame(task, completed.result.task)
        }

        val snap = task.coroutinesAwait()
        assertEquals(64L, snap.bytesTransferred)
        assertTrue(completedFlag.get())
        assertEquals(64, succeededBytes.get())
        assertTrue(directExecCount.get() >= 3)
        assertFalse(task.isInProgress)
        assertFalse(task.isPaused)
    }

    @Test
    fun canceledUploadTaskExposesErrorCanceledOnTaskAndThrowsStorageExceptionFromAwait(): Unit = runBlocking {
        // Use a transport that holds worker-op frames without replying so the task stays in-progress until canceled.
        val deferredTransport = InMemoryBridgeTransport()
        deferredTransport.onServerReceive { message ->
            val frame = JsonCodec.decodeMap(message)
            if (frame["type"] == "attach") {
                val ack = mapOf(
                    "type" to "attach-ack",
                    "protocol" to 1,
                    "clientSessionId" to (frame["clientSessionId"] ?: "deferred"),
                    "peerConnected" to true
                )
                deferredTransport.sendToClient(JsonCodec.encodeToString(ack))
            }
        }
        val deferredClient = PyricBridgeClient(deferredTransport)
        val deferredStorage = FirebaseStorage.getInstance(
            FirebaseApp.initializeApp(
                "deferred-app",
                FirebaseOptions.Builder()
                    .setProjectId("def-proj")
                    .setApiKey("k")
                    .setApplicationId("a")
                    .setStorageBucket("def-proj.appspot.com")
                    .build()
            ),
            deferredClient
        )
        val ref = deferredStorage.getReference("uploads/in-flight.bin")
        val task = ref.putBytes(byteArrayOf(1, 2, 3, 4))

        assertTrue(task.isInProgress)
        assertFalse(task.isComplete)

        val canceledCallbackFired = AtomicBoolean(false)
        val failureExceptionCodes = CopyOnWriteArrayList<Int>()
        val completedSawCanceled = AtomicBoolean(false)

        task.addOnCanceledListener { canceledCallbackFired.set(true) }
        task.addOnFailureListener { ex ->
            if (ex is StorageException) {
                failureExceptionCodes.add(ex.errorCode)
            }
        }
        task.addOnCompleteListener { done ->
            completedSawCanceled.set(done.isCanceled)
        }

        assertTrue(task.cancel())
        assertFalse(task.cancel())
        assertTrue(task.isCanceled)
        assertTrue(task.isComplete)
        assertFalse(task.isSuccessful)
        assertFalse(task.isInProgress)
        assertTrue(canceledCallbackFired.get())
        assertTrue(completedSawCanceled.get())
        assertEquals(listOf(StorageException.ERROR_CANCELED), failureExceptionCodes.toList())
        assertEquals(StorageException.ERROR_CANCELED, (task.exception as StorageException).errorCode)
        assertEquals(StorageException.ERROR_CANCELED, (task.snapshot.error as StorageException).errorCode)

        assertThrows<CancellationException> {
            task.result
        }

        val coroutinesEx = assertThrows<StorageException> {
            task.coroutinesAwait()
        }
        assertEquals(StorageException.ERROR_CANCELED, coroutinesEx.errorCode)

        val gmsEx = assertThrows<StorageException> {
            task.gmsAwait()
        }
        assertEquals(StorageException.ERROR_CANCELED, gmsEx.errorCode)

        deferredClient.terminate()
        Unit
    }

    @Test
    fun multiPartPutBytesStreamsChunksAbove4MiBAndAbortsStagedUploadOnFailure(): Unit = runBlocking {
        val multiChunkBytes = ByteArray(4 * 1024 * 1024 + 12_345) { idx ->
            ((idx * 17 + 5) and 0xFF).toByte()
        }
        val ref = storage.getReference("large/video.mp4")
        val progressOffsets = CopyOnWriteArrayList<Long>()
        val task = ref.putBytes(multiChunkBytes)
        task.addOnProgressListener { snap -> progressOffsets.add(snap.bytesTransferred) }
        val snap = task.coroutinesAwait()

        assertEquals(multiChunkBytes.size.toLong(), snap.bytesTransferred)
        val methods = harness.recordedOps.map { it["method"] as String }
        assertTrue(methods.contains("storage.beginUpload"))
        assertEquals(17, methods.count { it == "storage.putPart" })
        assertTrue(methods.contains("storage.finishUpload"))

        val downloaded = ref.getBytes(5L * 1024L * 1024L).coroutinesAwait()
        assertArrayEquals(multiChunkBytes, downloaded)

        // Force failure on second upload's putPart and verify best-effort storage.abortUpload runs.
        harness.recordedOps.clear()
        val failingTransport = InMemoryMultipartFailOnceHarness()
        val failStorage = FirebaseStorage.getInstance(
            FirebaseApp.initializeApp(
                "fail-part-app",
                FirebaseOptions.Builder()
                    .setProjectId("fp")
                    .setApiKey("k")
                    .setApplicationId("a")
                    .setStorageBucket("fp.appspot.com")
                    .build()
            ),
            failingTransport.client
        )
        val failEx = assertThrows<StorageException> {
            failStorage.getReference("large/broken.mp4").putBytes(multiChunkBytes).coroutinesAwait()
        }
        assertEquals(StorageException.ERROR_RETRY_LIMIT_EXCEEDED, failEx.errorCode)
        assertTrue(failingTransport.methods.contains("storage.abortUpload"))
        failingTransport.client.terminate()
        Unit
    }

    @Test
    fun zeroByteUploadMetadataCloneClearAndInvalidPageTokenHandling(): Unit = runBlocking {
        val emptyRef = storage.getReference("empty/zero.bin")
        val snap = emptyRef.putBytes(
            ByteArray(0),
            StorageMetadata.Builder()
                .setContentType("application/x-empty")
                .setCustomMetadata("keep", "1")
                .setCustomMetadata("drop", "2")
                .build()
        ).coroutinesAwait()
        assertEquals(0L, snap.totalByteCount)
        assertEquals(0L, snap.bytesTransferred)
        assertArrayEquals(ByteArray(0), emptyRef.getBytes(64L).coroutinesAwait())

        // Cloning server metadata via Builder(serverMeta) preserves untouched custom keys while clearing null keys.
        val serverMeta = emptyRef.getMetadata().coroutinesAwait()
        val clonedPatch = StorageMetadata.Builder(serverMeta)
            .setCustomMetadata("drop", null)
            .setCustomMetadata("added", "3")
            .build()
        val updated = emptyRef.updateMetadata(clonedPatch).coroutinesAwait()
        assertEquals("application/x-empty", updated.contentType)
        assertEquals("1", updated.getCustomMetadata("keep"))
        assertNull(updated.getCustomMetadata("drop"))
        assertEquals("3", updated.getCustomMetadata("added"))

        val badCursorEx = assertThrows<StorageException> {
            storage.getReference("empty").list(10, "not-a-valid-cursor-token!!!").coroutinesAwait()
        }
        assertEquals(StorageException.ERROR_UNKNOWN, badCursorEx.errorCode)
    }

    @Test
    fun installedAppCheckProviderAttachesAppCheckTokenToStorageBridgeOps(): Unit = runBlocking {
        val acClient = harness.newBridgeClient()
        val acApp = FirebaseApp.initializeApp(
            "ac-storage-app",
            FirebaseOptions.Builder()
                .setProjectId("ac-proj")
                .setApiKey("ac-key")
                .setApplicationId("1:555:android:ac")
                .setStorageBucket("ac-proj.appspot.com")
                .build()
        )
        val appCheck = FirebaseAppCheck.getInstance(acApp, acClient)
        appCheck.installAppCheckProviderFactory(DebugAppCheckProviderFactory.getInstance())
        val acStorage = FirebaseStorage.getInstance(acApp, acClient)

        harness.recordedOps.clear()
        acStorage.getReference("guarded/item.txt").putBytes("ok".toByteArray(Charsets.UTF_8)).coroutinesAwait()
        val putOp = harness.recordedOps.first { it["method"] == "storage.putBytes" }
        assertEquals("mock-app-check-jwt", putOp["appCheckToken"])
    }
}

private class InMemoryMultipartFailOnceHarness {
    val methods = CopyOnWriteArrayList<String>()
    private val transport = InMemoryBridgeTransport()
    val client = PyricBridgeClient(transport)

    init {
        transport.onServerReceive { raw ->
            val frame = JsonCodec.decodeMap(raw)
            when (frame["type"]) {
                "attach" -> transport.sendToClient(
                    JsonCodec.encodeToString(
                        mapOf(
                            "type" to "attach-ack",
                            "protocol" to 1,
                            "clientSessionId" to (frame["clientSessionId"] ?: "s"),
                            "peerConnected" to true
                        )
                    )
                )
                "worker-op" -> {
                    val id = frame["id"] as String
                    @Suppress("UNCHECKED_CAST")
                    val op = frame["op"] as Map<String, Any?>
                    val method = op["method"] as String
                    methods.add(method)
                    when (method) {
                        "storage.beginUpload" -> transport.sendToClient(
                            JsonCodec.encodeToString(
                                mapOf("type" to "worker-res", "id" to id, "ok" to true, "value" to mapOf("uploadId" to "u-fail"))
                            )
                        )
                        "storage.putPart" -> transport.sendToClient(
                            JsonCodec.encodeToString(
                                mapOf(
                                    "type" to "worker-res",
                                    "id" to id,
                                    "ok" to false,
                                    "error" to mapOf("code" to "storage/retry-limit-exceeded", "message" to "part timeout")
                                )
                            )
                        )
                        else -> transport.sendToClient(
                            JsonCodec.encodeToString(mapOf("type" to "worker-res", "id" to id, "ok" to true, "value" to null))
                        )
                    }
                }
            }
        }
    }
}

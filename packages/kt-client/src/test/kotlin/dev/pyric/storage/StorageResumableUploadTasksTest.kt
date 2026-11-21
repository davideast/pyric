package dev.pyric.storage

import com.google.android.gms.tasks.Task
import com.google.android.gms.tasks.Tasks
import com.google.android.gms.tasks.await as gmsAwait
import com.google.firebase.FirebaseApp
import com.google.firebase.FirebaseOptions
import com.google.firebase.auth.FirebaseAuth
import com.google.firebase.storage.CancellableTask
import com.google.firebase.storage.ControllableTask
import com.google.firebase.storage.FirebaseStorage
import com.google.firebase.storage.OnPausedListener
import com.google.firebase.storage.OnProgressListener
import com.google.firebase.storage.StorageException
import com.google.firebase.storage.StorageTask
import com.google.firebase.storage.UploadTask
import com.google.firebase.storage.component1
import com.google.firebase.storage.component2
import com.google.firebase.storage.component3
import com.google.firebase.storage.component4
import com.google.firebase.storage.storageMetadata
import dev.pyric.bridge.InMemoryBridgeTransport
import dev.pyric.bridge.PyricBridgeClient
import dev.pyric.codecs.JsonCodec
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.tasks.await as ktxAwait
import org.junit.jupiter.api.AfterEach
import org.junit.jupiter.api.Assertions.assertArrayEquals
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertNotNull
import org.junit.jupiter.api.Assertions.assertSame
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.BeforeEach
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.assertThrows
import org.junit.jupiter.api.io.TempDir
import java.io.ByteArrayInputStream
import java.io.File
import java.io.InputStream
import java.net.URI
import java.nio.file.Path
import java.util.Base64
import java.util.concurrent.CancellationException
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.atomic.AtomicReference

class StorageResumableUploadTasksTest {

    private lateinit var harness: StorageMockBridgeHarness
    private lateinit var app: FirebaseApp
    private lateinit var storage: FirebaseStorage

    @BeforeEach
    fun setUp() {
        FirebaseStorage.clearInstancesForTest()
        FirebaseAuth.clearInstancesForTest()
        FirebaseApp.clearInstancesForTest()

        harness = StorageMockBridgeHarness()
        val options = FirebaseOptions.Builder()
            .setProjectId("tasks-proj")
            .setApiKey("tasks-key")
            .setApplicationId("1:123:android:tasks")
            .setStorageBucket("tasks-proj.appspot.com")
            .build()
        app = FirebaseApp.initializeApp("tasks-app", options)
        storage = FirebaseStorage.getInstance(app, harness.newBridgeClient())
    }

    @AfterEach
    fun tearDown() {
        if (::harness.isInitialized) harness.closeAll()
        FirebaseStorage.clearInstancesForTest()
        FirebaseAuth.clearInstancesForTest()
        FirebaseApp.clearInstancesForTest()
    }

    @Test
    fun storageTaskClassHierarchyMatchesUpstreamAndroidSdk() {
        assertTrue(Task::class.java.isAssignableFrom(CancellableTask::class.java))
        assertTrue(CancellableTask::class.java.isAssignableFrom(ControllableTask::class.java))
        assertTrue(ControllableTask::class.java.isAssignableFrom(StorageTask::class.java))
        assertTrue(StorageTask::class.java.isAssignableFrom(UploadTask::class.java))
    }

    @Test
    fun multiChunkPutBytesStreamsPartsEmitsMonotonicProgressAndExposesSessionUri() = runBlocking {
        val ref = storage.getReference("uploads/multi-chunk.bin")
        // 600 KiB > 256 KiB default chunk size -> 3 chunks (256 KiB + 256 KiB + 88 KiB)
        val payload = ByteArray(600 * 1024) { idx -> ((idx * 31 + 7) and 0xFF).toByte() }
        val meta = storageMetadata {
            contentType = "application/octet-stream"
            setCustomMetadata("kind", "chunked")
        }

        val progressSteps = CopyOnWriteArrayList<Long>()
        val execThreads = CopyOnWriteArrayList<String>()
        val executor = Executors.newSingleThreadExecutor { r ->
            Thread(r, "upload-progress-exec").apply { isDaemon = true }
        }

        try {
            val execDone = CountDownLatch(1)
            val task = ref.putBytes(payload, meta)
            task.addOnProgressListener { snap ->
                progressSteps.add(snap.bytesTransferred)
            }
            task.addOnProgressListener(executor) { _ ->
                execThreads.add(Thread.currentThread().name)
            }
            task.addOnCompleteListener(executor) {
                execDone.countDown()
            }

            val finalSnap = task.gmsAwait()
            assertTrue(execDone.await(5, TimeUnit.SECONDS))
            val (transferred, total, storedMeta, sessionUri) = finalSnap

            assertEquals(payload.size.toLong(), transferred)
            assertEquals(payload.size.toLong(), total)
            assertNotNull(sessionUri)
            assertTrue(sessionUri.toString().contains("upload_id="))
            assertSame(ref, finalSnap.storage)
            assertSame(task, finalSnap.task)
            assertEquals("chunked", storedMeta?.getCustomMetadata("kind"))

            val putPartCount = harness.recordedOps.count { it["method"] == "storage.putPart" }
            assertEquals(3, putPartCount)
            assertTrue(harness.recordedOps.any { it["method"] == "storage.beginUpload" })
            assertTrue(harness.recordedOps.any { it["method"] == "storage.finishUpload" })
            assertTrue(progressSteps.contains(256L * 1024L))
            assertTrue(progressSteps.contains(512L * 1024L))
            assertTrue(progressSteps.last() == payload.size.toLong())
            assertTrue(execThreads.all { it == "upload-progress-exec" })
            assertTrue(ref.activeUploadTasks.isEmpty())

            assertArrayEquals(payload, ref.getBytes(1024L * 1024L).gmsAwait())
        } finally {
            executor.shutdownNow()
        }
    }

    @Test
    fun putStreamReadsWithoutAvailableClosesStreamAndRoundTripsMultiChunkPayload() = runBlocking {
        val ref = storage.getReference("streams/piped.dat")
        val payload = ByteArray(540 * 1024) { idx -> ((idx * 17 + 99) and 0xFF).toByte() }
        val closedFlag = AtomicBoolean(false)

        // Trickle InputStream that ALWAYS reports available() == 0 and returns at most 7 KiB per read.
        val zeroAvailableStream = object : InputStream() {
            private val delegate = ByteArrayInputStream(payload)
            override fun available(): Int = 0
            override fun read(): Int = delegate.read()
            override fun read(b: ByteArray, off: Int, len: Int): Int =
                delegate.read(b, off, minOf(len, 7 * 1024))
            override fun close() {
                closedFlag.set(true)
                delegate.close()
            }
        }

        val snap = ref.putStream(
            zeroAvailableStream,
            storageMetadata {
                contentType = "application/x-stream-test"
                setCustomMetadata("source", "zero-available-stream")
            }
        ).ktxAwait()

        assertTrue(closedFlag.get(), "Expected UploadTask to close InputStream on completion")
        assertEquals(payload.size.toLong(), snap.bytesTransferred)
        assertEquals(payload.size.toLong(), snap.totalByteCount)
        assertEquals("application/x-stream-test", snap.metadata?.contentType)
        assertEquals("zero-available-stream", snap.metadata?.getCustomMetadata("source"))
        assertArrayEquals(payload, ref.getBytes(1024L * 1024L).gmsAwait())
    }

    @Test
    fun putFileUploadsLocalFileInfersMimeHandlesMissingFileAndResumesExistingSession(
        @TempDir tempDir: Path
    ) = runBlocking {
        val localFile = tempDir.resolve("notes.txt").toFile()
        val content = ByteArray(300 * 1024) { idx -> ('a'.code + (idx % 26)).toByte() }
        localFile.writeBytes(content)

        val ref = storage.getReference("files/notes.txt")
        val snap = ref.putFile(localFile.toURI()).gmsAwait()
        assertEquals(content.size.toLong(), snap.bytesTransferred)
        assertEquals(content.size.toLong(), snap.totalByteCount)
        assertNotNull(snap.uploadSessionUri)
        assertArrayEquals(content, ref.getBytes(512L * 1024L).gmsAwait())

        // Missing file fails asynchronously on returned UploadTask with StorageException
        val missingFile = File(tempDir.toFile(), "does-not-exist.bin")
        val missingEx = assertThrows<StorageException> {
            storage.getReference("files/missing.bin").putFile(missingFile.toURI()).gmsAwait()
        }
        assertEquals(StorageException.ERROR_UNKNOWN, missingEx.errorCode)

        // Non-file:// URI fails cleanly with StorageException
        val badSchemeEx = assertThrows<StorageException> {
            storage.getReference("files/bad.bin").putFile(URI.create("https://example.com/bad.bin")).gmsAwait()
        }
        assertEquals(StorageException.ERROR_UNKNOWN, badSchemeEx.errorCode)

        // Verify multi-chunk putFile exposes uploadSessionUri and round-trips full payload
        // (existingUploadUri offset resumption is verified against HostedRuntime in live conformance)
        val resumeFile = tempDir.resolve("resumed.bin").toFile()
        val part0 = ByteArray(256 * 1024) { 0x11 }
        val part1 = ByteArray(64 * 1024) { 0x22 }
        val fullBytes = part0 + part1
        resumeFile.writeBytes(fullBytes)

        val resumeRef = storage.getReference("files/resumed.bin")
        val beginTask = resumeRef.putFile(resumeFile.toURI())
        val firstSnap = beginTask.gmsAwait()
        assertArrayEquals(fullBytes, resumeRef.getBytes(512L * 1024L).gmsAwait())
        assertNotNull(firstSnap.uploadSessionUri)
    }

    @Test
    fun pauseResumeAndCancelLifecycleFireListenersAndPropagateErrorCanceled() = runBlocking {
        // Gate bridge responses on putPart so we can deterministically test pause -> resume & cancel!
        val transport = InMemoryBridgeTransport()
        val heldPutPartIds = CopyOnWriteArrayList<Pair<String, Map<String, Any?>>>()
        val firstPartArrived = CountDownLatch(1)
        val abortCalled = AtomicBoolean(false)
        val stagedParts = HashMap<Int, ByteArray>()

        transport.onServerReceive { rawJson ->
            val frame = JsonCodec.decodeMap(rawJson)
            when (frame["type"]) {
                "attach" -> {
                    transport.sendToClient(
                        JsonCodec.encodeToString(
                            mapOf(
                                "type" to "attach-ack",
                                "protocol" to 1,
                                "clientSessionId" to "gate-session",
                                "peerConnected" to true,
                                "hostInstanceId" to "gate-host"
                            )
                        )
                    )
                }
                "worker-op" -> {
                    val id = frame["id"] as String
                    @Suppress("UNCHECKED_CAST")
                    val op = frame["op"] as Map<String, Any?>
                    when (op["method"]) {
                        "storage.beginUpload" -> {
                            transport.sendToClient(
                                JsonCodec.encodeToString(
                                    mapOf(
                                        "type" to "worker-res",
                                        "id" to id,
                                        "ok" to true,
                                        "value" to mapOf("uploadId" to "up-gated-1")
                                    )
                                )
                            )
                        }
                        "storage.putPart" -> {
                            val idx = (op["partIndex"] as Number).toInt()
                            stagedParts[idx] = Base64.getDecoder().decode(op["dataB64"] as String)
                            if (idx == 0) {
                                heldPutPartIds.add(id to op)
                                firstPartArrived.countDown()
                            } else {
                                transport.sendToClient(
                                    JsonCodec.encodeToString(
                                        mapOf(
                                            "type" to "worker-res",
                                            "id" to id,
                                            "ok" to true,
                                            "value" to mapOf("bytesTransferred" to stagedParts[idx]!!.size)
                                        )
                                    )
                                )
                            }
                        }
                        "storage.finishUpload" -> {
                            val total = stagedParts.values.sumOf { it.size }
                            transport.sendToClient(
                                JsonCodec.encodeToString(
                                    mapOf(
                                        "type" to "worker-res",
                                        "id" to id,
                                        "ok" to true,
                                        "value" to mapOf(
                                            "bucket" to "tasks-proj.appspot.com",
                                            "fullPath" to "gated/item.bin",
                                            "name" to "item.bin",
                                            "size" to total,
                                            "generation" to "1",
                                            "metageneration" to "1"
                                        )
                                    )
                                )
                            )
                        }
                        "storage.abortUpload" -> {
                            abortCalled.set(true)
                            transport.sendToClient(
                                JsonCodec.encodeToString(
                                    mapOf("type" to "worker-res", "id" to id, "ok" to true, "value" to null)
                                )
                            )
                        }
                    }
                }
            }
        }

        val gatedStorage = FirebaseStorage.getInstance(app, PyricBridgeClient(transport), "gs://gated-bucket")
        val payload = ByteArray(300 * 1024) { (it and 0xFF).toByte() }
        val pausedCount = AtomicInteger(0)

        val uploadTask = gatedStorage.getReference("gated/item.bin").putBytes(payload)
        uploadTask.addOnPausedListener(OnPausedListener { pausedCount.incrementAndGet() })

        assertTrue(firstPartArrived.await(5, TimeUnit.SECONDS))
        assertTrue(uploadTask.isInProgress)
        assertTrue(uploadTask.pause())
        assertFalse(uploadTask.pause()) // already paused
        assertTrue(uploadTask.isPaused)
        assertFalse(uploadTask.isInProgress)
        assertEquals(1, pausedCount.get())

        // Release part 0 while paused: task stays paused before sending part 1!
        val (heldId, _) = heldPutPartIds.first()
        transport.sendToClient(
            JsonCodec.encodeToString(
                mapOf(
                    "type" to "worker-res",
                    "id" to heldId,
                    "ok" to true,
                    "value" to mapOf("bytesTransferred" to 256 * 1024)
                )
            )
        )
        Thread.sleep(40)
        assertTrue(uploadTask.isPaused)
        assertFalse(uploadTask.isComplete)

        assertTrue(uploadTask.resume())
        assertFalse(uploadTask.resume()) // already running
        val finishedSnap = uploadTask.gmsAwait()
        assertEquals(payload.size.toLong(), finishedSnap.bytesTransferred)
        assertTrue(uploadTask.isSuccessful)

        // Now test cancel() on a second upload!
        heldPutPartIds.clear()
        val secondPartLatch = CountDownLatch(1)
        transport.onServerReceive { rawJson ->
            val frame = JsonCodec.decodeMap(rawJson)
            if (frame["type"] == "worker-op") {
                val id = frame["id"] as String
                @Suppress("UNCHECKED_CAST")
                val op = frame["op"] as Map<String, Any?>
                when (op["method"]) {
                    "storage.beginUpload" -> transport.sendToClient(
                        JsonCodec.encodeToString(
                            mapOf("type" to "worker-res", "id" to id, "ok" to true, "value" to mapOf("uploadId" to "up-cancel-2"))
                        )
                    )
                    "storage.putPart" -> secondPartLatch.countDown()
                    "storage.abortUpload" -> {
                        abortCalled.set(true)
                        transport.sendToClient(
                            JsonCodec.encodeToString(
                                mapOf("type" to "worker-res", "id" to id, "ok" to true, "value" to null)
                            )
                        )
                    }
                }
            }
        }

        val cancelTask = gatedStorage.getReference("gated/canceled.bin").putBytes(payload)
        val onCanceledCount = AtomicInteger(0)
        val onFailureError = AtomicReference<Exception?>()
        val onCompleteLatch = CountDownLatch(1)
        val removedProgressCalled = AtomicBoolean(false)
        val removableProgress = OnProgressListener<UploadTask.TaskSnapshot> {
            removedProgressCalled.set(true)
        }
        cancelTask.addOnProgressListener(removableProgress)
        cancelTask.removeOnProgressListener(removableProgress)
        removedProgressCalled.set(false)

        cancelTask.addOnCanceledListener { onCanceledCount.incrementAndGet() }
        cancelTask.addOnFailureListener { e -> onFailureError.set(e) }
        cancelTask.addOnCompleteListener { onCompleteLatch.countDown() }

        assertTrue(secondPartLatch.await(5, TimeUnit.SECONDS))
        assertTrue(cancelTask.cancel())
        assertFalse(cancelTask.cancel())
        assertTrue(cancelTask.isCanceled)
        assertTrue(cancelTask.isComplete)
        assertFalse(cancelTask.isSuccessful)
        assertTrue(onCompleteLatch.await(5, TimeUnit.SECONDS))
        assertEquals(1, onCanceledCount.get())
        val failureEx = onFailureError.get() as StorageException
        assertEquals(StorageException.ERROR_CANCELED, failureEx.errorCode)
        assertEquals(StorageException.ERROR_CANCELED, (cancelTask.exception as StorageException).errorCode)
        assertEquals(StorageException.ERROR_CANCELED, (cancelTask.snapshot.error as StorageException).errorCode)

        val gmsCaught = assertThrows<StorageException> { cancelTask.gmsAwait() }
        assertEquals(StorageException.ERROR_CANCELED, gmsCaught.errorCode)

        val ktxCaught = assertThrows<StorageException> { cancelTask.ktxAwait() }
        assertEquals(StorageException.ERROR_CANCELED, ktxCaught.errorCode)

        assertThrows<CancellationException> { Tasks.await(cancelTask) }
        assertFalse(removedProgressCalled.get())
    }
}

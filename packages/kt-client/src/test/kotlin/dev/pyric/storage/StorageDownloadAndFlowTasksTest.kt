package dev.pyric.storage

import com.google.android.gms.tasks.await
import com.google.firebase.FirebaseApp
import com.google.firebase.FirebaseOptions
import com.google.firebase.auth.FirebaseAuth
import com.google.firebase.storage.FileDownloadTask
import com.google.firebase.storage.FirebaseStorage
import com.google.firebase.storage.StorageException
import com.google.firebase.storage.StorageTask
import com.google.firebase.storage.StreamDownloadTask
import com.google.firebase.storage.TaskState
import com.google.firebase.storage.component1
import com.google.firebase.storage.component2
import com.google.firebase.storage.component3
import com.google.firebase.storage.storageMetadata
import com.google.firebase.storage.taskState
import dev.pyric.bridge.InMemoryBridgeTransport
import dev.pyric.bridge.PyricBridgeClient
import dev.pyric.codecs.JsonCodec
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.catch
import kotlinx.coroutines.flow.toList
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
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
import org.junit.jupiter.api.io.TempDir
import java.io.ByteArrayOutputStream
import java.io.IOException
import java.net.URI
import java.nio.file.Path
import java.util.Base64
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean

class StorageDownloadAndFlowTasksTest {

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
            .setProjectId("dl-proj")
            .setApiKey("dl-key")
            .setApplicationId("1:123:android:dl")
            .setStorageBucket("dl-proj.appspot.com")
            .build()
        app = FirebaseApp.initializeApp("dl-app", options)
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
    fun fileDownloadTaskStreamsMultiChunkDataSupportsUriAndFileOverloadsAndHandlesErrors(
        @TempDir tempDir: Path
    ) = runBlocking {
        assertTrue(StorageTask::class.java.isAssignableFrom(FileDownloadTask::class.java))
        assertTrue(StorageTask::class.java.isAssignableFrom(StreamDownloadTask::class.java))

        val payload = ByteArray(580 * 1024) { idx -> ((idx * 53 + 11) and 0xFF).toByte() }
        val ref = storage.getReference("downloads/archive.tar")
        ref.putBytes(payload).await()

        val targetFile = tempDir.resolve("nested/dir/archive.tar").toFile()
        val progressOffsets = CopyOnWriteArrayList<Long>()
        val fileTask = ref.getFile(targetFile)
        fileTask.addOnProgressListener { snap ->
            progressOffsets.add(snap.bytesTransferred)
        }

        val snap = fileTask.await()
        val (transferred, total) = snap
        assertEquals(payload.size.toLong(), transferred)
        assertEquals(payload.size.toLong(), total)
        assertSame(ref, snap.storage)
        assertSame(fileTask, snap.task)
        assertArrayEquals(payload, targetFile.readBytes())
        assertTrue(progressOffsets.contains(256L * 1024L))
        assertTrue(progressOffsets.contains(512L * 1024L))
        assertEquals(payload.size.toLong(), progressOffsets.last())
        assertTrue(ref.activeDownloadTasks.isEmpty())

        // URI overload + 0-byte empty object round-trip
        val emptyRef = storage.getReference("downloads/empty.bin")
        emptyRef.putBytes(ByteArray(0)).await()
        val emptyTarget = tempDir.resolve("empty.bin").toFile()
        val emptySnap = emptyRef.getFile(emptyTarget.toURI()).await()
        assertEquals(0L, emptySnap.bytesTransferred)
        assertEquals(0L, emptySnap.totalByteCount)
        assertEquals(0, emptyTarget.readBytes().size)

        // Missing object does not create destination file and fails with ERROR_OBJECT_NOT_FOUND
        val untouched = tempDir.resolve("untouched.bin").toFile()
        val notFound = assertThrows<StorageException> {
            storage.getReference("downloads/missing.bin").getFile(untouched).await()
        }
        assertEquals(StorageException.ERROR_OBJECT_NOT_FOUND, notFound.errorCode)
        assertFalse(untouched.exists())

        // Directory destination fails with StorageException
        val dirDestEx = assertThrows<StorageException> {
            ref.getFile(tempDir.toFile()).await()
        }
        assertEquals(StorageException.ERROR_UNKNOWN, dirDestEx.errorCode)

        // Root reference getFile fails with StorageException
        val rootEx = assertThrows<StorageException> {
            storage.reference.getFile(tempDir.resolve("root.bin").toFile()).await()
        }
        assertEquals(StorageException.ERROR_UNKNOWN, rootEx.errorCode)
    }

    @Test
    fun fileDownloadTaskPauseResumeAndCancelPreserveExactByteContinuity(
        @TempDir tempDir: Path
    ) = runBlocking {
        val fullPayload = ByteArray(512 * 1024) { idx -> ((idx * 19 + 5) and 0xFF).toByte() }
        val transport = InMemoryBridgeTransport()
        val firstChunkHeld = CopyOnWriteArrayList<String>()
        val requestedOffsets = CopyOnWriteArrayList<Int>()
        val firstChunkRequested = CountDownLatch(1)

        transport.onServerReceive { rawJson ->
            val frame = JsonCodec.decodeMap(rawJson)
            if (frame["type"] == "attach") {
                transport.sendToClient(
                    JsonCodec.encodeToString(
                        mapOf(
                            "type" to "attach-ack",
                            "protocol" to 1,
                            "clientSessionId" to "dl-gate",
                            "peerConnected" to true,
                            "hostInstanceId" to "dl-host"
                        )
                    )
                )
            } else if (frame["type"] == "worker-op") {
                val id = frame["id"] as String
                @Suppress("UNCHECKED_CAST")
                val op = frame["op"] as Map<String, Any?>
                when (op["method"]) {
                    "storage.getMetadata" -> {
                        transport.sendToClient(
                            JsonCodec.encodeToString(
                                mapOf(
                                    "type" to "worker-res",
                                    "id" to id,
                                    "ok" to true,
                                    "value" to mapOf(
                                        "bucket" to "dl-proj.appspot.com",
                                        "fullPath" to "gated/file.bin",
                                        "name" to "file.bin",
                                        "size" to fullPayload.size,
                                        "generation" to "77",
                                        "metageneration" to "1"
                                    )
                                )
                            )
                        )
                    }
                    "storage.getBytes" -> {
                        val off = (op["offset"] as Number).toInt()
                        val len = (op["length"] as Number).toInt()
                        requestedOffsets.add(off)
                        if (off == 0 && firstChunkHeld.isEmpty()) {
                            firstChunkHeld.add(id)
                            firstChunkRequested.countDown()
                        } else {
                            val slice = fullPayload.copyOfRange(off, minOf(off + len, fullPayload.size))
                            transport.sendToClient(
                                JsonCodec.encodeToString(
                                    mapOf(
                                        "type" to "worker-res",
                                        "id" to id,
                                        "ok" to true,
                                        "value" to mapOf(
                                            "dataB64" to Base64.getEncoder().encodeToString(slice),
                                            "size" to slice.size,
                                            "generation" to "77"
                                        )
                                    )
                                )
                            )
                        }
                    }
                }
            }
        }

        val dlStorage = FirebaseStorage.getInstance(app, PyricBridgeClient(transport), "gs://dl-gated")
        val outFile = tempDir.resolve("paused-dl.bin").toFile()
        val pausedLatch = CountDownLatch(1)
        val task = dlStorage.getReference("gated/file.bin").getFile(outFile)
        task.addOnPausedListener { pausedLatch.countDown() }

        assertTrue(firstChunkRequested.await(5, TimeUnit.SECONDS))
        assertTrue(task.pause())
        assertTrue(pausedLatch.await(5, TimeUnit.SECONDS))
        assertTrue(task.isPaused)

        val heldId = firstChunkHeld.first()
        val firstSlice = fullPayload.copyOfRange(0, 256 * 1024)
        transport.sendToClient(
            JsonCodec.encodeToString(
                mapOf(
                    "type" to "worker-res",
                    "id" to heldId,
                    "ok" to true,
                    "value" to mapOf(
                        "dataB64" to Base64.getEncoder().encodeToString(firstSlice),
                        "size" to firstSlice.size,
                        "generation" to "77"
                    )
                )
            )
        )
        kotlinx.coroutines.yield()
        assertTrue(task.isPaused)
        assertFalse(task.isComplete)
        assertEquals(listOf(0), requestedOffsets.toList())

        assertTrue(task.resume())
        val done = task.await()
        assertEquals(fullPayload.size.toLong(), done.bytesTransferred)
        assertArrayEquals(fullPayload, outFile.readBytes())
        assertEquals(256 * 1024, requestedOffsets.last())
    }

    @Test
    fun streamDownloadTaskSupportsProcessorAndDirectStreamAndRejectsPauseResume() = runBlocking {
        val payload = ByteArray(400 * 1024) { idx -> ((idx * 41 + 3) and 0xFF).toByte() }
        val ref = storage.getReference("streams/video.mp4")
        ref.putBytes(payload, storageMetadata { contentType = "video/mp4" }).await()

        // 1. StreamProcessor overload runs in background, updates progress, and closes stream
        val processorOut = ByteArrayOutputStream()
        val progressEvents = CopyOnWriteArrayList<Long>()
        val processorTask = ref.getStream { _, stream ->
            val buf = ByteArray(16 * 1024)
            while (true) {
                val r = stream.read(buf)
                if (r == -1) break
                processorOut.write(buf, 0, r)
            }
        }
        processorTask.addOnProgressListener { snap ->
            progressEvents.add(snap.bytesTransferred)
        }

        // pause() and resume() must throw UnsupportedOperationException on StreamDownloadTask
        assertThrows<UnsupportedOperationException> { processorTask.pause() }
        assertThrows<UnsupportedOperationException> { processorTask.resume() }

        val processorSnap = processorTask.await()
        val (transferred, total, closedStream) = processorSnap
        assertEquals(payload.size.toLong(), transferred)
        assertEquals(payload.size.toLong(), total)
        assertArrayEquals(payload, processorOut.toByteArray())
        assertTrue(progressEvents.isNotEmpty())
        assertThrows<IOException> { closedStream.read() }

        // 2. No-arg getStream() exposes live InputStream on TaskSnapshot
        val directSnap = ref.getStream().await()
        val directBytes = directSnap.stream.use { it.readBytes() }
        assertArrayEquals(payload, directBytes)

        // 3. Cancel mid-stream causes subsequent stream.read() to throw IOException with ERROR_CANCELED
        val cancelStreamTask = ref.getStream()
        val openedSnap = cancelStreamTask.await()
        // A new in-progress processor task canceled mid-read:
        val enteredProcessor = CountDownLatch(1)
        val allowContinue = CountDownLatch(1)
        val processorExited = CountDownLatch(1)
        val sawCanceledIo = AtomicBoolean(false)
        val midCancelTask = ref.getStream { _, stream ->
            try {
                val firstByte = stream.read()
                assertTrue(firstByte >= 0)
                enteredProcessor.countDown()
                assertTrue(allowContinue.await(5, TimeUnit.SECONDS))
                try {
                    stream.read(ByteArray(1024))
                } catch (ioe: IOException) {
                    if ((ioe.cause as? StorageException)?.errorCode == StorageException.ERROR_CANCELED) {
                        sawCanceledIo.set(true)
                    }
                    throw ioe
                }
            } finally {
                processorExited.countDown()
            }
        }
        assertTrue(enteredProcessor.await(5, TimeUnit.SECONDS))
        assertTrue(midCancelTask.cancel())
        allowContinue.countDown()
        val cancelAwaitEx = assertThrows<StorageException> { midCancelTask.await() }
        assertEquals(StorageException.ERROR_CANCELED, cancelAwaitEx.errorCode)
        assertTrue(processorExited.await(5, TimeUnit.SECONDS))
        assertTrue(sawCanceledIo.get())
        openedSnap.stream.close()
    }

    @Test
    fun streamDownloadLateProgressAndMidStreamCancelRemainDeterministicUnderContention() = runBlocking {
        val payload = ByteArray(64 * 1024) { idx -> ((idx * 17 + 9) and 0xFF).toByte() }
        val ref = storage.getReference("streams/contention.bin")
        ref.putBytes(payload).await()

        repeat(250) { round ->
            val progressEvents = CopyOnWriteArrayList<Long>()
            val processorTask = ref.getStream { _, stream ->
                val drain = ByteArray(16 * 1024)
                while (stream.read(drain) != -1) {
                    // consume
                }
            }
            processorTask.addOnProgressListener { snap ->
                progressEvents.add(snap.bytesTransferred)
            }
            val snap = processorTask.await()
            assertEquals(payload.size.toLong(), snap.bytesTransferred, "round=$round")
            assertTrue(progressEvents.isNotEmpty(), "round=$round empty progressEvents")

            val entered = CountDownLatch(1)
            val release = CountDownLatch(1)
            val exited = CountDownLatch(1)
            val canceledIo = AtomicBoolean(false)
            val cancelTask = ref.getStream { _, stream ->
                try {
                    val b = stream.read()
                    assertTrue(b >= 0)
                    entered.countDown()
                    assertTrue(release.await(5, TimeUnit.SECONDS))
                    try {
                        stream.read(ByteArray(512))
                    } catch (ioe: IOException) {
                        if ((ioe.cause as? StorageException)?.errorCode == StorageException.ERROR_CANCELED) {
                            canceledIo.set(true)
                        }
                        throw ioe
                    }
                } finally {
                    exited.countDown()
                }
            }
            assertTrue(entered.await(5, TimeUnit.SECONDS))
            assertTrue(cancelTask.cancel())
            release.countDown()
            val ex = assertThrows<StorageException> { cancelTask.await() }
            assertEquals(StorageException.ERROR_CANCELED, ex.errorCode)
            assertTrue(exited.await(5, TimeUnit.SECONDS))
            assertTrue(canceledIo.get(), "round=$round canceledIo")
        }
    }

    @Test
    fun taskStateFlowEmitsInProgressAndPausedAndPropagatesErrorsToCatch(
        @TempDir tempDir: Path
    ) = runBlocking {
        val payload = ByteArray(520 * 1024) { idx -> ((idx * 29 + 7) and 0xFF).toByte() }
        val ref = storage.getReference("flows/dataset.bin")

        val uploadTask = ref.putBytes(payload)
        val uploadStates = uploadTask.taskState.toList()
        assertTrue(uploadStates.isNotEmpty())
        assertTrue(uploadStates.all { it is TaskState.InProgress })
        val lastUploadSnap = (uploadStates.last() as TaskState.InProgress).snapshot
        assertEquals(payload.size.toLong(), lastUploadSnap.bytesTransferred)

        // Late collector on already-completed UploadTask receives terminal InProgress and completes
        val lateStates = uploadTask.taskState.toList()
        assertEquals(1, lateStates.size)
        assertEquals(
            payload.size.toLong(),
            (lateStates.single() as TaskState.InProgress).snapshot.bytesTransferred
        )

        // Download taskState Flow
        val dlFile = tempDir.resolve("flow-dl.bin").toFile()
        val dlStates = ref.getFile(dlFile).taskState.toList()
        assertTrue(dlStates.isNotEmpty())
        assertEquals(
            payload.size.toLong(),
            (dlStates.last() as TaskState.InProgress).snapshot.bytesTransferred
        )
        assertArrayEquals(payload, dlFile.readBytes())

        // Error propagation through Flow.catch on missing object (may emit initial 0-byte InProgress if subscribed before IO failure settles)
        val caughtFlowError = CopyOnWriteArrayList<Throwable>()
        val missingStates = storage.getReference("flows/does-not-exist.bin")
            .getFile(URI.create(tempDir.resolve("nope.bin").toUri().toString()))
            .taskState
            .catch { err -> caughtFlowError.add(err) }
            .toList()
        assertTrue(missingStates.all { it is TaskState.InProgress && it.snapshot.bytesTransferred == 0L })
        assertEquals(1, caughtFlowError.size)
        val stEx = caughtFlowError.single() as StorageException
        assertEquals(StorageException.ERROR_OBJECT_NOT_FOUND, stEx.errorCode)

        // Pause -> Resume emission sequence on taskState Flow
        val partArrived = CountDownLatch(1)
        val heldId = CopyOnWriteArrayList<String>()
        val gatedTransport = createGatedFlowUploadTransport(payload.size, heldId, partArrived)

        val gatedClient = PyricBridgeClient(gatedTransport)
        try {
            val gatedStorage = FirebaseStorage.getInstance(app, gatedClient, "gs://flow-bucket")
            val pausableUpload = gatedStorage.getReference("flow/item.bin").putBytes(payload)
            val collected = CopyOnWriteArrayList<TaskState<*>>()
            val collectorReady = CountDownLatch(1)
            val pausedCollected = CountDownLatch(1)
            val collectorJob = launch(Dispatchers.Default) {
                pausableUpload.taskState.collect { state ->
                    collected.add(state)
                    collectorReady.countDown()
                    if (state is TaskState.Paused) {
                        pausedCollected.countDown()
                    }
                }
            }

            assertTrue(collectorReady.await(5, TimeUnit.SECONDS))
            assertTrue(partArrived.await(5, TimeUnit.SECONDS))
            assertTrue(pausableUpload.pause())
            gatedTransport.sendToClient(
                JsonCodec.encodeToString(
                    mapOf(
                        "type" to "worker-res",
                        "id" to heldId.first(),
                        "ok" to true,
                        "value" to mapOf("bytesTransferred" to 256 * 1024)
                    )
                )
            )
            assertTrue(pausedCollected.await(5, TimeUnit.SECONDS))
            assertTrue(pausableUpload.resume())
            collectorJob.join()

            assertTrue(collected.any { it is TaskState.Paused })
            assertTrue(collected.last() is TaskState.InProgress)
            assertNull(pausableUpload.exception)
        } finally {
            gatedClient.terminate()
        }
    }
}

private fun createGatedFlowUploadTransport(
    payloadSize: Int,
    heldId: MutableList<String>,
    partArrived: CountDownLatch
): InMemoryBridgeTransport {
    val gatedTransport = InMemoryBridgeTransport()
    gatedTransport.onServerReceive { rawJson ->
        val frame = JsonCodec.decodeMap(rawJson)
        if (frame["type"] == "attach") {
            gatedTransport.sendToClient(
                JsonCodec.encodeToString(
                    mapOf(
                        "type" to "attach-ack",
                        "protocol" to 1,
                        "clientSessionId" to "flow-gate",
                        "peerConnected" to true,
                        "hostInstanceId" to "flow-host"
                    )
                )
            )
        } else if (frame["type"] == "worker-op") {
            val id = frame["id"] as String
            @Suppress("UNCHECKED_CAST")
            val op = frame["op"] as Map<String, Any?>
            when (op["method"]) {
                "storage.beginUpload" -> gatedTransport.sendToClient(
                    JsonCodec.encodeToString(
                        mapOf("type" to "worker-res", "id" to id, "ok" to true, "value" to mapOf("uploadId" to "u-flow"))
                    )
                )
                "storage.putPart" -> {
                    val idx = (op["partIndex"] as Number).toInt()
                    if (idx == 0 && heldId.isEmpty()) {
                        heldId.add(id)
                        partArrived.countDown()
                    } else {
                        gatedTransport.sendToClient(
                            JsonCodec.encodeToString(
                                mapOf("type" to "worker-res", "id" to id, "ok" to true, "value" to mapOf("bytesTransferred" to 1024))
                            )
                        )
                    }
                }
                "storage.finishUpload" -> gatedTransport.sendToClient(
                    JsonCodec.encodeToString(
                        mapOf(
                            "type" to "worker-res",
                            "id" to id,
                            "ok" to true,
                            "value" to mapOf(
                                "bucket" to "flow-bucket",
                                "fullPath" to "flow/item.bin",
                                "name" to "item.bin",
                                "size" to payloadSize
                            )
                        )
                    )
                )
            }
        }
    }
    return gatedTransport
}

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
import com.google.android.gms.tasks.Tasks
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.async
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
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executor
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.atomic.AtomicReference

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

    @Test
    fun awaitWaitsBehindInFlightOnCompleteListenerAndDeferredListeners(): Unit = runBlocking {
        // Gate the worker inside the initial OnCompleteListener dispatch across all three await APIs
        // (kotlinx.coroutines.tasks.await, com.google.android.gms.tasks.await, Tasks.await).
        for (mode in listOf("coroutines", "gms", "tasks")) {
            val enteredComplete = CountDownLatch(1)
            val releaseComplete = CountDownLatch(1)
            val completedFinished = AtomicBoolean(false)
            val asyncExecSawComplete = AtomicBoolean(false)
            val asyncExecDone = CountDownLatch(1)
            val asyncExecutor = Executors.newSingleThreadExecutor { r ->
                Thread(r, "complete-check-$mode").apply { isDaemon = true }
            }
            val lateOrder = CopyOnWriteArrayList<String>()
            val gated = GatedStorageBridge("gated-app-$mode")
            try {
                val task = gated.storage.getReference("uploads/gated-$mode.bin")
                    .putBytes(ByteArray(16) { 0x11 })
                task.addOnCompleteListener(asyncExecutor) { done ->
                    asyncExecSawComplete.set(done.isComplete && done.isSuccessful)
                    asyncExecDone.countDown()
                }
                task.addOnCompleteListener { done ->
                    assertTrue(done.isComplete, "mode=$mode callback saw isComplete=false")
                    // Re-entrant listener and await from the settling thread must not deadlock.
                    val reentrantFlag = AtomicBoolean(false)
                    done.addOnCompleteListener { reentrantFlag.set(it.isSuccessful) }
                    assertTrue(reentrantFlag.get(), "mode=$mode reentrant listener did not run")
                    assertEquals(16L, Tasks.await(done).bytesTransferred)
                    enteredComplete.countDown()
                    assertTrue(releaseComplete.await(5, TimeUnit.SECONDS))
                    completedFinished.set(true)
                    lateOrder.add("initial-complete")
                }

                gated.respondOk("uploads/gated-$mode.bin", size = 16)
                assertTrue(enteredComplete.await(5, TimeUnit.SECONDS))
                // An already-dispatched async executor listener must observe isComplete == true
                // even while the worker is still blocked in a sibling OnCompleteListener.
                assertTrue(asyncExecDone.await(5, TimeUnit.SECONDS))
                assertTrue(asyncExecSawComplete.get(), "mode=$mode async executor saw isComplete=false")

                // Pre-complete listeners (progress/success) registered during COMPLETE dispatch
                // replay immediately once pre-complete settlement has finished, while late
                // OnCompleteListeners queue FIFO behind the in-flight OnCompleteListener and
                // before any subsequent await().
                task.addOnProgressListener { lateOrder.add("late-progress") }
                task.addOnSuccessListener { lateOrder.add("late-success") }
                assertEquals(
                    listOf("late-progress", "late-success"),
                    lateOrder.toList(),
                    "mode=$mode late progress/success should replay immediately once pre-complete finished"
                )
                task.addOnCompleteListener { lateOrder.add("late-complete") }

                val waiterEntered = CountDownLatch(1)
                val waiterReturned = CompletableDeferred<Pair<Boolean, Boolean>>()
                val waiter = async(Dispatchers.Default) {
                    waiterEntered.countDown()
                    val snap = when (mode) {
                        "coroutines" -> task.coroutinesAwait()
                        "gms" -> task.gmsAwait()
                        else -> Tasks.await(task)
                    }
                    assertEquals(16L, snap.bytesTransferred)
                    lateOrder.add("await-returned")
                    waiterReturned.complete(completedFinished.get() to task.isComplete)
                }

                assertTrue(waiterEntered.await(5, TimeUnit.SECONDS))
                val jumpedAhead = kotlinx.coroutines.withTimeoutOrNull(40) { waiterReturned.await() } != null
                releaseComplete.countDown()
                waiter.await()

                val (sawCompleted, sawIsComplete) = waiterReturned.await()
                assertFalse(jumpedAhead, "mode=$mode await() returned before earlier OnCompleteListener finished")
                assertTrue(sawCompleted, "mode=$mode await() resumed with completedFinished=false")
                assertTrue(sawIsComplete, "mode=$mode task.isComplete was false after await()")
                assertEquals(
                    listOf("late-progress", "late-success", "initial-complete", "late-complete", "await-returned"),
                    lateOrder.toList(),
                    "mode=$mode listener delivery order"
                )
            } finally {
                releaseComplete.countDown()
                gated.close()
                asyncExecutor.shutdownNow()
            }
        }
    }

    @Test
    fun awaitWaitsBehindDeferredOnCompleteListenerQueuedDuringPreComplete(): Unit = runBlocking {
        for (mode in listOf("coroutines", "gms", "tasks")) {
            val enteredSuccess = CountDownLatch(1)
            val releaseSuccess = CountDownLatch(1)
            val enteredDeferredComplete = CountDownLatch(1)
            val releaseDeferredComplete = CountDownLatch(1)
            val deferredCompleteFinished = AtomicBoolean(false)
            val gated = GatedStorageBridge("deferred-complete-app-$mode")
            try {
                val task = gated.storage.getReference("uploads/deferred-complete-$mode.bin")
                    .putBytes(ByteArray(8) { 0x22 })
                task.addOnSuccessListener {
                    enteredSuccess.countDown()
                    assertTrue(releaseSuccess.await(5, TimeUnit.SECONDS))
                }
                gated.respondOk("uploads/deferred-complete-$mode.bin", size = 8)
                assertTrue(enteredSuccess.await(5, TimeUnit.SECONDS))

                // Register OnCompleteListener while settlingThread is inside PRE_COMPLETE (deferred).
                task.addOnCompleteListener {
                    enteredDeferredComplete.countDown()
                    assertTrue(releaseDeferredComplete.await(5, TimeUnit.SECONDS))
                    deferredCompleteFinished.set(true)
                }
                releaseSuccess.countDown()
                assertTrue(enteredDeferredComplete.await(5, TimeUnit.SECONDS))

                val waiterEntered = CountDownLatch(1)
                val seenFinished = CompletableDeferred<Boolean>()
                val waiter = async(Dispatchers.Default) {
                    waiterEntered.countDown()
                    when (mode) {
                        "coroutines" -> task.coroutinesAwait()
                        "gms" -> task.gmsAwait()
                        else -> Tasks.await(task)
                    }
                    seenFinished.complete(deferredCompleteFinished.get())
                }
                assertTrue(waiterEntered.await(5, TimeUnit.SECONDS))
                val jumpedAhead = kotlinx.coroutines.withTimeoutOrNull(40) { seenFinished.await() } != null
                releaseDeferredComplete.countDown()
                waiter.await()

                assertFalse(jumpedAhead, "mode=$mode await() jumped ahead of deferred OnCompleteListener")
                assertTrue(
                    seenFinished.await(),
                    "mode=$mode deferred OnCompleteListener had not finished before await() returned"
                )
            } finally {
                releaseSuccess.countDown()
                releaseDeferredComplete.countDown()
                gated.close()
            }
        }
    }

    @Test
    fun uploadTaskExecutorListenersRemainConsistentAcrossRepeatedRaces(): Unit = runBlocking {
        val ref = storage.getReference("uploads/stress-listeners.bin")
        val payload = ByteArray(64) { 0x2A }
        repeat(400) { round ->
            val directExecCount = AtomicInteger(0)
            val executor = Executor { runnable ->
                directExecCount.incrementAndGet()
                runnable.run()
            }
            val task = ref.putBytes(payload)
            val completedFlag = AtomicBoolean(false)
            val succeededBytes = AtomicInteger(0)
            val removable = OnProgressListener<UploadTask.TaskSnapshot> { _ -> }

            task.addOnProgressListener(executor, removable)
            task.removeOnProgressListener(removable)
            task.addOnSuccessListener(executor) { snap ->
                succeededBytes.set(snap.bytesTransferred.toInt())
            }
            task.addOnCompleteListener(executor) { completed ->
                completedFlag.set(completed.isSuccessful)
            }

            val snap = when (round % 3) {
                0 -> task.coroutinesAwait()
                1 -> task.gmsAwait()
                else -> Tasks.await(task)
            }
            assertEquals(64L, snap.bytesTransferred, "round=$round")
            assertTrue(completedFlag.get(), "round=$round completedFlag was false after await")
            assertEquals(64, succeededBytes.get(), "round=$round succeededBytes")
            assertTrue(directExecCount.get() >= 3, "round=$round directExecCount=${directExecCount.get()}")
            assertTrue(task.isComplete, "round=$round isComplete")
            assertFalse(task.isInProgress, "round=$round isInProgress")
            assertFalse(task.isPaused, "round=$round isPaused")
        }
    }

    @Test
    fun failureAndCancelTerminalDispatchesReleaseSettlingAndOrderAwaitBehindOnComplete(): Unit = runBlocking {
        // 1. Failure path: gate inside OnCompleteListener during tryCompleteFailure.
        val failGate = GatedStorageBridge("fail-complete-gate-app")
        val enteredFailComplete = CountDownLatch(1)
        val releaseFailComplete = CountDownLatch(1)
        val failCompleteFinished = AtomicBoolean(false)
        try {
            val failTask = failGate.storage.getReference("uploads/fail-gate.bin").putBytes(byteArrayOf(1, 2, 3))
            failTask.addOnCompleteListener { done ->
                assertFalse(done.isSuccessful)
                assertTrue(done.isComplete)
                enteredFailComplete.countDown()
                assertTrue(releaseFailComplete.await(5, TimeUnit.SECONDS))
                failCompleteFinished.set(true)
            }
            failGate.respondError("storage/unauthorized", "denied")
            assertTrue(enteredFailComplete.await(5, TimeUnit.SECONDS))

            val waiterEntered = CountDownLatch(1)
            val awaitSawFinished = CompletableDeferred<Boolean>()
            val waiter = async(Dispatchers.Default) {
                waiterEntered.countDown()
                val ex = assertThrows<StorageException> { failTask.coroutinesAwait() }
                assertEquals(StorageException.ERROR_NOT_AUTHORIZED, ex.errorCode)
                awaitSawFinished.complete(failCompleteFinished.get())
            }
            assertTrue(waiterEntered.await(5, TimeUnit.SECONDS))
            val jumped = kotlinx.coroutines.withTimeoutOrNull(40) { awaitSawFinished.await() } != null
            releaseFailComplete.countDown()
            waiter.await()
            assertFalse(jumped, "failure coroutinesAwait() jumped ahead of OnCompleteListener")
            assertTrue(awaitSawFinished.await())
        } finally {
            releaseFailComplete.countDown()
            failGate.close()
        }

        // 2. Cancel path: gate inside OnCompleteListener during concurrent cancel().
        val cancelGate = GatedStorageBridge("cancel-gate-app")
        val enteredCancelComplete = CountDownLatch(1)
        val releaseCancelComplete = CountDownLatch(1)
        val cancelCompleteFinished = AtomicBoolean(false)
        try {
            val cancelTask = cancelGate.storage.getReference("uploads/cancel-gate.bin").putBytes(byteArrayOf(7, 8))
            cancelTask.addOnCompleteListener { done ->
                assertTrue(done.isCanceled)
                assertTrue(done.isComplete)
                enteredCancelComplete.countDown()
                assertTrue(releaseCancelComplete.await(5, TimeUnit.SECONDS))
                cancelCompleteFinished.set(true)
            }
            val cancelJob = async(Dispatchers.IO) {
                assertTrue(cancelTask.cancel())
            }
            assertTrue(enteredCancelComplete.await(5, TimeUnit.SECONDS))
            val waiterEntered = CountDownLatch(1)
            val cancelWaiterSawFinished = CompletableDeferred<Boolean>()
            val cancelWaiter = async(Dispatchers.Default) {
                waiterEntered.countDown()
                val ex = assertThrows<StorageException> { cancelTask.gmsAwait() }
                assertEquals(StorageException.ERROR_CANCELED, ex.errorCode)
                cancelWaiterSawFinished.complete(cancelCompleteFinished.get())
            }
            assertTrue(waiterEntered.await(5, TimeUnit.SECONDS))
            val jumpedCancel = kotlinx.coroutines.withTimeoutOrNull(40) { cancelWaiterSawFinished.await() } != null
            releaseCancelComplete.countDown()
            cancelJob.await()
            cancelWaiter.await()
            assertFalse(jumpedCancel, "cancel gmsAwait() jumped ahead of OnCompleteListener")
            assertTrue(cancelWaiterSawFinished.await())
        } finally {
            releaseCancelComplete.countDown()
            cancelGate.close()
        }

        // 3. Rejecting Executor inside OnCompleteListener must not strand settlingThread.
        val rejectGate = GatedStorageBridge("cancel-reject-app")
        try {
            val task = rejectGate.storage.getReference("uploads/cancel-reject.bin").putBytes(byteArrayOf(4, 5))
            val rejectingExecutor = Executor { throw java.util.concurrent.RejectedExecutionException("boom") }
            task.addOnCompleteListener(rejectingExecutor) { }
            assertThrows<java.util.concurrent.RejectedExecutionException> {
                task.cancel()
            }
            val otherThreadCheck = async(Dispatchers.Default) {
                kotlinx.coroutines.withTimeout(5_000) {
                    assertTrue(task.isCanceled)
                    assertTrue(task.isComplete)
                    val err = assertThrows<StorageException> { task.coroutinesAwait() }
                    assertEquals(StorageException.ERROR_CANCELED, err.errorCode)
                    val gmsErr = assertThrows<StorageException> { task.gmsAwait() }
                    assertEquals(StorageException.ERROR_CANCELED, gmsErr.errorCode)
                }
            }
            otherThreadCheck.await()
        } finally {
            rejectGate.close()
        }
    }
}

private class GatedStorageBridge(appName: String) {
    private val transport = InMemoryBridgeTransport()
    private val opId = AtomicReference<String?>()
    private val opArrived = CountDownLatch(1)
    private val client: PyricBridgeClient
    val storage: FirebaseStorage

    init {
        transport.onServerReceive { raw ->
            val frame = JsonCodec.decodeMap(raw)
            when (frame["type"]) {
                "attach" -> transport.sendToClient(
                    JsonCodec.encodeToString(
                        mapOf(
                            "type" to "attach-ack",
                            "protocol" to 1,
                            "clientSessionId" to (frame["clientSessionId"] ?: appName),
                            "peerConnected" to true
                        )
                    )
                )
                "worker-op" -> {
                    opId.set(frame["id"] as String)
                    opArrived.countDown()
                }
            }
        }
        client = PyricBridgeClient(transport)
        val app = FirebaseApp.initializeApp(
            appName,
            FirebaseOptions.Builder()
                .setProjectId("edge-proj")
                .setApiKey("edge-key")
                .setApplicationId("1:777:android:$appName")
                .setStorageBucket("edge-proj.appspot.com")
                .build()
        )
        storage = FirebaseStorage.getInstance(app, client)
    }

    fun respondOk(fullPath: String, size: Int) {
        assertTrue(opArrived.await(5, TimeUnit.SECONDS))
        transport.sendToClient(
            JsonCodec.encodeToString(
                mapOf(
                    "type" to "worker-res",
                    "id" to opId.get()!!,
                    "ok" to true,
                    "value" to mapOf(
                        "bucket" to "edge-proj.appspot.com",
                        "fullPath" to fullPath,
                        "name" to fullPath.substringAfterLast('/'),
                        "size" to size,
                        "generation" to "1",
                        "metageneration" to "1",
                        "contentType" to "application/octet-stream"
                    )
                )
            )
        )
    }

    fun respondError(code: String, message: String) {
        assertTrue(opArrived.await(5, TimeUnit.SECONDS))
        transport.sendToClient(
            JsonCodec.encodeToString(
                mapOf(
                    "type" to "worker-res",
                    "id" to opId.get()!!,
                    "ok" to false,
                    "error" to mapOf("code" to code, "message" to message)
                )
            )
        )
    }

    fun close() {
        client.terminate()
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

package dev.pyric.storage

import com.google.android.gms.tasks.Tasks
import com.google.android.gms.tasks.await as gmsAwait
import com.google.firebase.FirebaseApp
import com.google.firebase.FirebaseOptions
import com.google.firebase.auth.FirebaseAuth
import com.google.firebase.storage.FirebaseStorage
import com.google.firebase.storage.StorageException
import com.google.firebase.storage.StorageTask
import com.google.firebase.storage.storageMetadata
import com.google.firebase.storage.taskState
import com.sun.net.httpserver.HttpExchange
import com.sun.net.httpserver.HttpServer
import dev.pyric.bridge.InMemoryBridgeTransport
import dev.pyric.bridge.PyricBridgeClient
import dev.pyric.codecs.JsonCodec
import java.io.ByteArrayInputStream
import java.io.IOException
import java.net.InetSocketAddress
import java.nio.file.Path
import java.util.concurrent.CancellationException
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.flow.catch
import kotlinx.coroutines.flow.toList
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.tasks.await as ktxAwait
import org.junit.jupiter.api.AfterEach
import org.junit.jupiter.api.Assertions.assertArrayEquals
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertThrows
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.BeforeEach
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.io.TempDir

class StorageConcurrencyAndCancelParityTest {

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
            .setProjectId("conc-proj")
            .setApiKey("conc-key")
            .setApplicationId("1:123:android:conc")
            .setStorageBucket("conc-proj.appspot.com")
            .build()
        app = FirebaseApp.initializeApp("conc-app", options)
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
    fun concurrentUploadsAndDownloadsToDistinctObjectsMaintainPayloadIntegrity(
        @TempDir tempDir: Path
    ) {
        runBlocking {
            val workerCount = 12
            val payloads = (0 until workerCount).map { i ->
                ByteArray((i + 1) * 40 * 1024) { idx -> ((idx * 31 + i * 17) and 0xFF).toByte() }
            }

            coroutineScope {
                (0 until workerCount).map { i ->
                    async(Dispatchers.IO) {
                        val ref = storage.getReference("parallel/item-$i.bin")
                        val meta = storageMetadata { setCustomMetadata("slot", i.toString()) }
                        when (i % 3) {
                            0 -> ref.putBytes(payloads[i], meta).gmsAwait()
                            1 -> ref.putStream(ByteArrayInputStream(payloads[i]), meta).ktxAwait()
                            else -> {
                                val f = tempDir.resolve("src-$i.bin").toFile().apply { writeBytes(payloads[i]) }
                                ref.putFile(f.toURI(), meta).gmsAwait()
                            }
                        }
                    }
                }.awaitAll()
            }

            coroutineScope {
                (0 until workerCount).map { i ->
                    async(Dispatchers.IO) {
                        val ref = storage.getReference("parallel/item-$i.bin")
                        val gotMeta = ref.getMetadata().gmsAwait()
                        assertEquals(i.toString(), gotMeta.getCustomMetadata("slot"))
                        val downloaded = when (i % 3) {
                            0 -> ref.getBytes(1024L * 1024L).gmsAwait()
                            1 -> {
                                val out = tempDir.resolve("dl-$i.bin").toFile()
                                ref.getFile(out).ktxAwait()
                                out.readBytes()
                            }
                            else -> ref.getStream().gmsAwait().stream.use { it.readBytes() }
                        }
                        assertArrayEquals(payloads[i], downloaded)
                    }
                }.awaitAll()
            }
        }
    }

    @Test
    fun concurrentOverwritesToSameObjectLeaveConsistentWinningGeneration() {
        runBlocking {
            val ref = storage.getReference("shared/contested.bin")
            val variants = (0 until 8).map { v ->
                ByteArray(128 * 1024 + v * 512) { idx -> ((idx + v * 29) and 0xFF).toByte() }
            }

            coroutineScope {
                variants.mapIndexed { idx, bytes ->
                    async(Dispatchers.IO) {
                        ref.putBytes(
                            bytes,
                            storageMetadata { setCustomMetadata("writer", idx.toString()) }
                        ).gmsAwait()
                    }
                }.awaitAll()
            }

            val winningMeta = ref.getMetadata().gmsAwait()
            val winnerIdx = winningMeta.getCustomMetadata("writer")!!.toInt()
            val winningBytes = ref.getBytes(512L * 1024L).gmsAwait()
            assertArrayEquals(variants[winnerIdx], winningBytes)
            assertEquals(variants[winnerIdx].size.toLong(), winningMeta.sizeBytes)
            assertTrue(ref.activeUploadTasks.isEmpty())
        }
    }

    @Test
    fun httpByteRouteDownloadRetriesCleanlyOn412GenerationOverwriteRace() {
        runBlocking {
            val v1Bytes = "version-one-payload".toByteArray(Charsets.UTF_8)
            val v2Bytes = "version-two-updated-payload-after-overwrite".toByteArray(Charsets.UTF_8)
            val metadataCalls = AtomicInteger(0)
            val getAttempts = AtomicInteger(0)

            withByteRouteDownloadFixture(
                app = app,
                bucket = "gen-bkt",
                onMetadataCall = {
                    val callNum = metadataCalls.incrementAndGet()
                    mapOf(
                        "bucket" to "gen-bkt",
                        "fullPath" to "race/doc.txt",
                        "name" to "doc.txt",
                        "size" to if (callNum == 1) v1Bytes.size else v2Bytes.size,
                        "generation" to if (callNum == 1) "1" else "2"
                    )
                },
                onHttpExchange = { exchange ->
                    val attempt = getAttempts.incrementAndGet()
                    val query = exchange.requestURI.rawQuery ?: ""
                    if (attempt == 1 && query.contains("generation=1")) {
                        exchange.sendResponseHeaders(412, -1)
                        exchange.close()
                    } else {
                        exchange.sendResponseHeaders(200, v2Bytes.size.toLong())
                        exchange.responseBody.use { it.write(v2Bytes) }
                    }
                }
            ) { raceStorage ->
                val result = raceStorage.getReference("race/doc.txt").getBytes(4096L).gmsAwait()
                assertArrayEquals(v2Bytes, result)
                assertEquals(2, metadataCalls.get())
                assertEquals(2, getAttempts.get())
            }
        }
    }

    @Test
    fun activeUploadAndDownloadTaskRegistriesTrackAndEvictConcurrentWaves(
        @TempDir tempDir: Path
    ) {
        runBlocking {
            val arrivedIds = CopyOnWriteArrayList<String>()
            val eightArrived = CountDownLatch(8)
            val heldTransport = createPendingWorkerTransport("wave-s") { id ->
                arrivedIds.add(id)
                eightArrived.countDown()
            }

            val client = PyricBridgeClient(heldTransport)
            try {
                val waveStorage = FirebaseStorage.getInstance(app, client, "gs://wave-bkt")
                val ref = waveStorage.getReference("waves/blob.bin")

                val uploads = (0 until 4).map { i -> ref.putBytes(byteArrayOf(i.toByte())) }
                val downloads = (0 until 4).map { i -> ref.getFile(tempDir.resolve("w-$i.bin").toFile()) }

                assertTrue(eightArrived.await(5, TimeUnit.SECONDS))
                assertEquals(4, ref.activeUploadTasks.size)
                assertEquals(4, ref.activeDownloadTasks.size)

                assertTrue(uploads[0].cancel())
                assertTrue(uploads[1].cancel())
                assertTrue(downloads[0].cancel())
                assertTrue(downloads[1].cancel())
                assertEquals(2, ref.activeUploadTasks.size)
                assertEquals(2, ref.activeDownloadTasks.size)

                for (id in arrivedIds) {
                    heldTransport.sendToClient(
                        JsonCodec.encodeToString(
                            mapOf(
                                "type" to "worker-res",
                                "id" to id,
                                "ok" to false,
                                "error" to mapOf("code" to "permission-denied", "message" to "denied")
                            )
                        )
                    )
                }

                for (t in listOf(uploads[2], uploads[3], downloads[2], downloads[3])) {
                    val ex = assertThrows(StorageException::class.java) {
                        runBlocking { (t as StorageTask<*>).gmsAwait() }
                    }
                    assertEquals(StorageException.ERROR_NOT_AUTHORIZED, ex.errorCode)
                }
                assertTrue(ref.activeUploadTasks.isEmpty())
                assertTrue(ref.activeDownloadTasks.isEmpty())
            } finally {
                client.terminate()
            }
        }
    }

    @Test
    fun canceledUploadFileDownloadAndStreamDownloadPropagateErrorCanceledAcrossAllConsumers(
        @TempDir tempDir: Path
    ) {
        runBlocking {
            val opStarted = CountDownLatch(3)
            val stalledTransport = createPendingWorkerTransport("can-s") { opStarted.countDown() }
            val client = PyricBridgeClient(stalledTransport)
            try {
                val canStorage = FirebaseStorage.getInstance(app, client, "gs://can-bkt")
                val ref = canStorage.getReference("cancel/item.bin")

                val upTask = ref.putStream(ByteArrayInputStream(ByteArray(64 * 1024)))
                val fileTask = ref.getFile(tempDir.resolve("can-out.bin").toFile())
                val streamTask = ref.getStream()

                assertTrue(opStarted.await(5, TimeUnit.SECONDS))

                assertTaskCancelsCleanly(upTask)
                assertTaskCancelsCleanly(fileTask)
                assertTaskCancelsCleanly(streamTask)
            } finally {
                client.terminate()
            }
        }
    }

    @Test
    fun rangedDownload412MidTransferFailsWithErrorInvalidChecksumPreventingTornReads(
        @TempDir tempDir: Path
    ) {
        runBlocking {
            val totalLen = 512 * 1024
            val chunk0 = ByteArray(256 * 1024) { 0x41 }
            val rangeCalls = AtomicInteger(0)

            withByteRouteDownloadFixture(
                app = app,
                bucket = "torn-bkt",
                onMetadataCall = {
                    mapOf(
                        "bucket" to "torn-bkt",
                        "fullPath" to "torn/asset.bin",
                        "name" to "asset.bin",
                        "size" to totalLen,
                        "generation" to "10"
                    )
                },
                onHttpExchange = { exchange ->
                    if (rangeCalls.incrementAndGet() == 1) {
                        exchange.sendResponseHeaders(206, chunk0.size.toLong())
                        exchange.responseBody.use { it.write(chunk0) }
                    } else {
                        exchange.sendResponseHeaders(412, -1)
                        exchange.close()
                    }
                }
            ) { tornStorage ->
                val outFile = tempDir.resolve("torn.bin").toFile()
                val ex = assertThrows(StorageException::class.java) {
                    runBlocking { tornStorage.getReference("torn/asset.bin").getFile(outFile).gmsAwait() }
                }
                assertEquals(StorageException.ERROR_INVALID_CHECKSUM, ex.errorCode)
                assertEquals(412, ex.httpResultCode)
            }
        }
    }

    @Test
    fun hundredWaveListenerRegistrationAndAwaitRaceAgainstCompletionNeverLosesWakeup() {
        runBlocking {
            val totalWaves = 120
            val completedCallbacks = AtomicInteger(0)
            val successCallbacks = AtomicInteger(0)

            coroutineScope {
                (0 until totalWaves).map { i ->
                    async(Dispatchers.Default) {
                        val ref = storage.getReference("stress/wave-$i.bin")
                        val task = ref.putBytes(byteArrayOf((i and 0xFF).toByte(), 0x5A))
                        val doneLatch = CountDownLatch(1)
                        task.addOnSuccessListener { successCallbacks.incrementAndGet() }
                        task.addOnCompleteListener {
                            completedCallbacks.incrementAndGet()
                            doneLatch.countDown()
                        }
                        val states = task.taskState.toList()
                        assertTrue(states.isNotEmpty())
                        val snap = if (i % 2 == 0) task.gmsAwait() else task.ktxAwait()
                        assertEquals(2L, snap.bytesTransferred)
                        assertTrue(doneLatch.await(5, TimeUnit.SECONDS))
                    }
                }.awaitAll()
            }

            assertEquals(totalWaves, successCallbacks.get())
            assertEquals(totalWaves, completedCallbacks.get())
        }
    }
}

private fun createPendingWorkerTransport(
    sessionId: String,
    onWorkerOpId: (String) -> Unit
): InMemoryBridgeTransport {
    val transport = InMemoryBridgeTransport()
    transport.onServerReceive { rawJson ->
        val frame = JsonCodec.decodeMap(rawJson)
        if (frame["type"] == "attach") {
            transport.sendToClient(
                JsonCodec.encodeToString(
                    mapOf(
                        "type" to "attach-ack",
                        "protocol" to 1,
                        "clientSessionId" to sessionId,
                        "peerConnected" to true
                    )
                )
            )
        } else if (frame["type"] == "worker-op") {
            onWorkerOpId(frame["id"] as String)
        }
    }
    return transport
}

private suspend fun withByteRouteDownloadFixture(
    app: FirebaseApp,
    bucket: String,
    onMetadataCall: () -> Map<String, Any?>,
    onHttpExchange: (HttpExchange) -> Unit,
    block: suspend (FirebaseStorage) -> Unit
) {
    val httpServer = HttpServer.create(InetSocketAddress("127.0.0.1", 0), 0)
    httpServer.createContext("/__pyric/storage/v0/b/") { exchange -> onHttpExchange(exchange) }
    httpServer.start()
    val transport = InMemoryBridgeTransport()
    transport.onServerReceive { rawJson ->
        val frame = JsonCodec.decodeMap(rawJson)
        if (frame["type"] == "attach") {
            transport.sendToClient(
                JsonCodec.encodeToString(
                    mapOf(
                        "type" to "attach-ack",
                        "protocol" to 1,
                        "clientSessionId" to "byte-route-s",
                        "peerConnected" to true
                    )
                )
            )
        } else if (frame["type"] == "worker-op") {
            val id = frame["id"] as String
            @Suppress("UNCHECKED_CAST")
            val op = frame["op"] as Map<String, Any?>
            when (op["method"]) {
                "storage.getBytes" -> transport.sendToClient(
                    JsonCodec.encodeToString(
                        mapOf(
                            "type" to "worker-res",
                            "id" to id,
                            "ok" to false,
                            "error" to mapOf(
                                "code" to "failed-precondition",
                                "message" to "This host moves Storage bytes over its HTTP byte route"
                            )
                        )
                    )
                )
                "storage.getMetadata" -> transport.sendToClient(
                    JsonCodec.encodeToString(
                        mapOf("type" to "worker-res", "id" to id, "ok" to true, "value" to onMetadataCall())
                    )
                )
            }
        }
    }
    val port = httpServer.address.port
    val client = PyricBridgeClient(url = "ws://127.0.0.1:$port/__pyric/ws", directTransport = transport)
    try {
        block(FirebaseStorage.getInstance(app, client, "gs://$bucket"))
    } finally {
        client.terminate()
        httpServer.stop(0)
    }
}

private suspend fun <T : StorageTask<T>.SnapshotBase> assertTaskCancelsCleanly(task: StorageTask<T>) {
    val flowErrors = CopyOnWriteArrayList<Throwable>()
    assertTrue(task.cancel())
    assertFalse(task.cancel())
    assertTrue(task.isCanceled)
    assertTrue(task.isComplete)
    assertFalse(task.isSuccessful)

    task.taskState.catch { flowErrors.add(it) }.toList()
    assertEquals(1, flowErrors.size)
    assertEquals(StorageException.ERROR_CANCELED, (flowErrors.single() as StorageException).errorCode)

    val gmsEx = assertThrows(StorageException::class.java) { runBlocking { task.gmsAwait() } }
    assertEquals(StorageException.ERROR_CANCELED, gmsEx.errorCode)

    val ktxEx = assertThrows(StorageException::class.java) { runBlocking { task.ktxAwait() } }
    assertEquals(StorageException.ERROR_CANCELED, ktxEx.errorCode)

    assertThrows(CancellationException::class.java) { Tasks.await(task) }
    assertThrows(CancellationException::class.java) { task.result }
    assertThrows(CancellationException::class.java) { task.getResult(IOException::class.java) }
}

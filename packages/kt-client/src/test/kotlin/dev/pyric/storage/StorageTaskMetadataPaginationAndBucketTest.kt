package dev.pyric.storage

import com.google.android.gms.tasks.OnCanceledListener
import com.google.android.gms.tasks.OnCompleteListener
import com.google.android.gms.tasks.OnFailureListener
import com.google.android.gms.tasks.OnSuccessListener
import com.google.android.gms.tasks.await
import com.google.firebase.FirebaseApp
import com.google.firebase.FirebaseOptions
import com.google.firebase.auth.FirebaseAuth
import com.google.firebase.storage.FirebaseStorage
import com.google.firebase.storage.OnPausedListener
import com.google.firebase.storage.OnProgressListener
import com.google.firebase.storage.StorageException
import com.google.firebase.storage.StorageMetadata
import com.google.firebase.storage.TaskState
import com.google.firebase.storage.UploadTask
import com.google.firebase.storage.storageMetadata
import com.google.firebase.storage.taskState
import com.sun.net.httpserver.HttpServer
import dev.pyric.bridge.InMemoryBridgeTransport
import dev.pyric.bridge.PyricBridgeClient
import dev.pyric.codecs.JsonCodec
import kotlinx.coroutines.flow.take
import kotlinx.coroutines.flow.toList
import kotlinx.coroutines.runBlocking
import org.junit.jupiter.api.AfterEach
import org.junit.jupiter.api.Assertions.assertArrayEquals
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertNotNull
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Assertions.assertThrows
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.BeforeEach
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.io.TempDir
import java.io.ByteArrayInputStream
import java.net.InetSocketAddress
import java.nio.file.Path
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.atomic.AtomicReference

class StorageTaskMetadataPaginationAndBucketTest {

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
            .setProjectId("pr2-proj")
            .setApiKey("pr2-key")
            .setApplicationId("1:123:android:pr2")
            .setStorageBucket("pr2-proj.appspot.com")
            .build()
        app = FirebaseApp.initializeApp("pr2-app", options)
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
    fun cancelDuringFinishCommitInvokesRollbackUploadAndPreservesPriorObject() = runBlocking {
        val transport = InMemoryBridgeTransport()
        val finishArrived = CountDownLatch(1)
        val finishIdRef = AtomicReference<String?>()
        val rollbackOps = CopyOnWriteArrayList<Map<String, Any?>>()
        val rollbackArrived = CountDownLatch(1)

        transport.onServerReceive { rawJson ->
            val frame = JsonCodec.decodeMap(rawJson)
            if (frame["type"] == "attach") {
                transport.sendToClient(
                    JsonCodec.encodeToString(
                        mapOf(
                            "type" to "attach-ack",
                            "protocol" to 1,
                            "clientSessionId" to "rb-session",
                            "peerConnected" to true,
                            "hostInstanceId" to "rb-host"
                        )
                    )
                )
            } else if (frame["type"] == "worker-op") {
                val id = frame["id"] as String
                @Suppress("UNCHECKED_CAST")
                val op = frame["op"] as Map<String, Any?>
                when (op["method"]) {
                    "storage.beginUpload" -> transport.sendToClient(
                        JsonCodec.encodeToString(
                            mapOf("type" to "worker-res", "id" to id, "ok" to true, "value" to mapOf("uploadId" to "rb-up-1"))
                        )
                    )
                    "storage.putPart" -> transport.sendToClient(
                        JsonCodec.encodeToString(
                            mapOf("type" to "worker-res", "id" to id, "ok" to true, "value" to mapOf("bytesTransferred" to 1024))
                        )
                    )
                    "storage.finishUpload" -> {
                        finishIdRef.set(id)
                        finishArrived.countDown()
                    }
                    "storage.rollbackUpload" -> {
                        rollbackOps.add(op)
                        rollbackArrived.countDown()
                        transport.sendToClient(
                            JsonCodec.encodeToString(
                                mapOf("type" to "worker-res", "id" to id, "ok" to true, "value" to null)
                            )
                        )
                    }
                }
            }
        }

        val rbStorage = FirebaseStorage.getInstance(app, PyricBridgeClient(transport), "gs://rb-bucket")
        val payload = ByteArray(300 * 1024) { (it and 0x7F).toByte() }
        val task = rbStorage.getReference("items/atomic.bin").putBytes(payload)

        assertTrue(finishArrived.await(5, TimeUnit.SECONDS))
        assertTrue(task.cancel())
        assertTrue(task.isCanceled)
        assertTrue(task.isComplete)

        transport.sendToClient(
            JsonCodec.encodeToString(
                mapOf(
                    "type" to "worker-res",
                    "id" to finishIdRef.get(),
                    "ok" to true,
                    "value" to mapOf(
                        "bucket" to "rb-bucket",
                        "fullPath" to "items/atomic.bin",
                        "name" to "atomic.bin",
                        "size" to payload.size,
                        "generation" to "99",
                        "rollbackToken" to "tok-rollback-99",
                        "replacedObject" to true
                    )
                )
            )
        )

        assertTrue(rollbackArrived.await(5, TimeUnit.SECONDS))
        assertEquals(1, rollbackOps.size)
        assertEquals("tok-rollback-99", rollbackOps.single()["rollbackToken"])
        assertEquals("storage.rollbackUpload", rollbackOps.single()["method"])

        val cancelEx = assertThrows(StorageException::class.java) {
            runBlocking { task.await() }
        }
        assertEquals(StorageException.ERROR_CANCELED, cancelEx.errorCode)
    }

    @Test
    fun lateListenersAttachedAfterCompletionOrCancellationReplayImmediatelyAndRespectExecutors() = runBlocking {
        val executor = Executors.newSingleThreadExecutor { r ->
            Thread(r, "late-listener-exec").apply { isDaemon = true }
        }
        try {
            val okRef = storage.getReference("listeners/ok.bin")
            val okTask = okRef.putBytes(byteArrayOf(10, 20, 30))
            okTask.await()

            val lateSuccess = AtomicInteger(0)
            val lateProgress = AtomicInteger(0)
            val lateComplete = CountDownLatch(1)
            val observedThread = AtomicReference<String?>()

            val sListener = OnSuccessListener<UploadTask.TaskSnapshot> { lateSuccess.incrementAndGet() }
            val pListener = OnProgressListener<UploadTask.TaskSnapshot> { lateProgress.incrementAndGet() }
            val cListener = OnCompleteListener<UploadTask.TaskSnapshot> {
                observedThread.set(Thread.currentThread().name)
                lateComplete.countDown()
            }
            val fListener = OnFailureListener { throw AssertionError("Should not fail") }
            val canListener = OnCanceledListener { throw AssertionError("Should not cancel") }
            val pausedListener = OnPausedListener<UploadTask.TaskSnapshot> { throw AssertionError("Not paused") }

            okTask.addOnSuccessListener(sListener)
            okTask.addOnProgressListener(pListener)
            okTask.addOnCompleteListener(executor, cListener)
            okTask.addOnFailureListener(fListener)
            okTask.addOnCanceledListener(canListener)
            okTask.addOnPausedListener(pausedListener)

            assertTrue(lateComplete.await(5, TimeUnit.SECONDS))
            assertEquals(1, lateSuccess.get())
            assertEquals(1, lateProgress.get())
            assertEquals("late-listener-exec", observedThread.get())

            okTask.removeOnSuccessListener(sListener)
            okTask.removeOnFailureListener(fListener)
            okTask.removeOnCompleteListener(cListener)
            okTask.removeOnCanceledListener(canListener)
            okTask.removeOnPausedListener(pausedListener)

            // Failed task late listener replay
            val failTask = storage.reference.putBytes(byteArrayOf(1))
            assertThrows(StorageException::class.java) {
                runBlocking { failTask.await() }
            }
            val lateFailLatch = CountDownLatch(1)
            failTask.addOnFailureListener(executor) { lateFailLatch.countDown() }
            assertTrue(lateFailLatch.await(5, TimeUnit.SECONDS))
        } finally {
            executor.shutdownNow()
        }
    }

    @Test
    fun updateMetadataClearsAndReplacesCustomKeysAndSettableFieldsAcrossPatchAndFallback() = runBlocking {
        val ref = storage.getReference("metadata/doc.json")
        val content = """{"ok":true}""".toByteArray(Charsets.UTF_8)
        ref.putBytes(
            content,
            storageMetadata {
                contentType = "application/json"
                cacheControl = "public, max-age=300"
                contentDisposition = "inline"
                contentEncoding = "identity"
                contentLanguage = "en"
                setCustomMetadata("k1", "v1")
                setCustomMetadata("k2", "v2")
                setCustomMetadata("k3", "v3")
            }
        ).await()

        // 1. Direct patch clearing k2 + contentDisposition, replacing k1, keeping k3
        val patched = ref.updateMetadata(
            StorageMetadata.Builder()
                .setContentDisposition(null)
                .setCustomMetadata("k1", "v1-updated")
                .setCustomMetadata("k2", null)
                .setCustomMetadata("k4", "v4")
                .build()
        ).await()

        assertNull(patched.contentDisposition)
        assertEquals("public, max-age=300", patched.cacheControl)
        assertEquals("v1-updated", patched.getCustomMetadata("k1"))
        assertNull(patched.getCustomMetadata("k2"))
        assertEquals("v3", patched.getCustomMetadata("k3"))
        assertEquals("v4", patched.getCustomMetadata("k4"))

        // 2. Client-lens re-upload fallback when storage.setMetadata is admin-gated
        harness.restrictSetMetadataToAdmin = true
        val fallbackPatched = ref.updateMetadata(
            StorageMetadata.Builder()
                .setCacheControl(null)
                .setContentLanguage("fr")
                .setCustomMetadata("k3", null)
                .setCustomMetadata("k4", "v4-final")
                .build()
        ).await()

        assertNull(fallbackPatched.cacheControl)
        assertEquals("fr", fallbackPatched.contentLanguage)
        assertEquals("v1-updated", fallbackPatched.getCustomMetadata("k1"))
        assertNull(fallbackPatched.getCustomMetadata("k3"))
        assertEquals("v4-final", fallbackPatched.getCustomMetadata("k4"))
        assertEquals(setOf("k1", "k4"), fallbackPatched.customMetadataKeys)
        assertArrayEquals(content, ref.getBytes(1024L).await())
    }

    @Test
    fun maxDownloadSizeBytesOverflowRejectsOversizePayloadsAcrossSingleFrameAndChunkedModes() = runBlocking {
        val ref = storage.getReference("limits/sample.bin")
        val payload = ByteArray(512) { (it and 0xFF).toByte() }
        ref.putBytes(payload).await()

        // Exact boundary (512 == 512) succeeds
        assertArrayEquals(payload, ref.getBytes(512L).await())

        // 1 byte over limit (512 > 511) fails with StorageException caused by IndexOutOfBoundsException
        val singleEx = assertThrows(StorageException::class.java) {
            runBlocking { ref.getBytes(511L).await() }
        }
        assertEquals(StorageException.ERROR_UNKNOWN, singleEx.errorCode)
        assertTrue(singleEx.cause is IndexOutOfBoundsException)

        // Chunked fallback mode also enforces maxDownloadSizeBytes via metadata check before allocating
        harness.forceSingleShotPayloadTooLargeAboveBytes = 128
        val chunkedEx = assertThrows(StorageException::class.java) {
            runBlocking { ref.getBytes(511L).await() }
        }
        assertEquals(StorageException.ERROR_UNKNOWN, chunkedEx.errorCode)
        assertTrue(chunkedEx.cause is IndexOutOfBoundsException)
        assertArrayEquals(payload, ref.getBytes(512L).await())
    }

    @Test
    fun paginatedListOrdersPrefixesAndItemsInUtf8LexicographicOrderAndValidatesArguments() = runBlocking {
        val folder = storage.getReference("catalog")
        val paths = listOf(
            "catalog/a-file.txt",
            "catalog/b-dir/nested-1.txt",
            "catalog/b-dir/nested-2.txt",
            "catalog/c-file.txt",
            "catalog/d-dir/deep/leaf.txt",
            "catalog/e-file.txt"
        )
        for (path in paths) {
            storage.getReference(path).putBytes(byteArrayOf(1)).await()
        }

        // Invalid bounds and tokens
        assertThrows(IllegalArgumentException::class.java) { folder.list(0) }
        assertThrows(IllegalArgumentException::class.java) { folder.list(1001) }
        assertThrows(IllegalArgumentException::class.java) { folder.list(2, "") }

        val badTokenEx = assertThrows(StorageException::class.java) {
            runBlocking { folder.list(2, "not-a-valid-cursor!!").await() }
        }
        assertEquals(StorageException.ERROR_UNKNOWN, badTokenEx.errorCode)

        // Expected sorted entries under catalog/:
        // 1. item: catalog/a-file.txt
        // 2. prefix: catalog/b-dir/
        // 3. item: catalog/c-file.txt
        // 4. prefix: catalog/d-dir/
        // 5. item: catalog/e-file.txt
        val page1 = folder.list(2).await()
        assertEquals(listOf("a-file.txt"), page1.items.map { it.name })
        assertEquals(listOf("b-dir"), page1.prefixes.map { it.name })
        assertNotNull(page1.pageToken)

        val page2 = folder.list(2, page1.pageToken!!).await()
        assertEquals(listOf("c-file.txt"), page2.items.map { it.name })
        assertEquals(listOf("d-dir"), page2.prefixes.map { it.name })
        assertNotNull(page2.pageToken)

        val page3 = folder.list(2, page2.pageToken!!).await()
        assertEquals(listOf("e-file.txt"), page3.items.map { it.name })
        assertTrue(page3.prefixes.isEmpty())
        assertNull(page3.pageToken)
    }

    @Test
    fun nonDefaultGsBucketsIsolatePutFilePutStreamGetFileAndGetStream(@TempDir tempDir: Path) = runBlocking {
        val secondary = FirebaseStorage.getInstance(app, storage.bridgeClient, "gs://secondary-bucket")
        val archive = FirebaseStorage.getInstance(app, storage.bridgeClient, "gs://archive-bucket")

        val defaultBytes = "default-bucket-data".toByteArray(Charsets.UTF_8)
        val secondaryBytes = "secondary-bucket-file".toByteArray(Charsets.UTF_8)
        val archiveBytes = "archive-bucket-stream".toByteArray(Charsets.UTF_8)

        val srcFile = tempDir.resolve("upload.txt").toFile().apply { writeBytes(secondaryBytes) }

        storage.getReference("shared/key.txt").putBytes(defaultBytes).await()
        secondary.getReference("shared/key.txt").putFile(srcFile.toURI()).await()
        archive.getReference("shared/key.txt").putStream(ByteArrayInputStream(archiveBytes)).await()

        val outSecondary = tempDir.resolve("dl-secondary.txt").toFile()
        secondary.getReference("shared/key.txt").getFile(outSecondary).await()
        assertArrayEquals(secondaryBytes, outSecondary.readBytes())

        val streamedArchive = archive.getReference("shared/key.txt")
            .getStream()
            .await()
            .stream
            .use { it.readBytes() }
        assertArrayEquals(archiveBytes, streamedArchive)
        assertArrayEquals(defaultBytes, storage.getReference("shared/key.txt").getBytes(1024L).await())
    }

    @Test
    fun taskStateFlowUnregistersListenersWhenCollectorCancelsEarly() = runBlocking {
        val payload = ByteArray(600 * 1024) { (it and 0xFF).toByte() }
        val ref = storage.getReference("flows/early-cancel.bin")
        val uploadTask = ref.putBytes(payload)

        val firstOnly = uploadTask.taskState.take(1).toList()
        assertEquals(1, firstOnly.size)
        assertTrue(firstOnly.single() is TaskState.InProgress)

        // Underlying uploadTask must NOT be canceled when the Flow collector stops early!
        val finalSnap = uploadTask.await()
        assertEquals(payload.size.toLong(), finalSnap.bytesTransferred)
        assertTrue(uploadTask.isSuccessful)
    }

    @Test
    fun httpByteRouteUploadAndDownloadTasksFallbackOnFailedPrecondition(@TempDir tempDir: Path) = runBlocking {
        val storedByUpload = ConcurrentHashMap<String, ByteArray>()
        val committedObjects = ConcurrentHashMap<String, ByteArray>()
        val httpServer = HttpServer.create(InetSocketAddress("127.0.0.1", 0), 0)
        httpServer.createContext("/__pyric/storage/upload/") { exchange ->
            val id = exchange.requestURI.path.substringAfterLast('/')
            val rangeHeader = exchange.requestHeaders.getFirst("Content-Range") ?: ""
            val body = exchange.requestBody.readBytes()
            val current = storedByUpload.getOrDefault(id, ByteArray(0))
            if (rangeHeader.startsWith("bytes */")) {
                val total = rangeHeader.substringAfter('/').toInt()
                if (current.size >= total) {
                    exchange.sendResponseHeaders(200, -1)
                } else {
                    if (current.isNotEmpty()) {
                        exchange.responseHeaders.set("Range", "bytes=0-${current.size - 1}")
                    }
                    exchange.sendResponseHeaders(308, -1)
                }
                exchange.close()
                return@createContext
            }
            val total = rangeHeader.substringAfter('/').toInt()
            val merged = current + body
            storedByUpload[id] = merged
            val status = if (merged.size >= total) 200 else 308
            if (status == 308 && merged.isNotEmpty()) {
                exchange.responseHeaders.set("Range", "bytes=0-${merged.size - 1}")
            }
            exchange.sendResponseHeaders(status, -1)
            exchange.close()
        }
        httpServer.createContext("/__pyric/storage/v0/b/") { exchange ->
            val rawPath = exchange.requestURI.rawPath
            val objPath = java.net.URLDecoder.decode(rawPath.substringAfter("/o/"), Charsets.UTF_8)
            val full = committedObjects[objPath] ?: ByteArray(0)
            val range = exchange.requestHeaders.getFirst("Range")
            if (range != null && range.startsWith("bytes=")) {
                val parts = range.removePrefix("bytes=").split('-')
                val s = parts[0].toInt()
                val e = minOf(parts[1].toInt() + 1, full.size)
                val slice = full.copyOfRange(s, e)
                exchange.sendResponseHeaders(206, slice.size.toLong())
                exchange.responseBody.use { it.write(slice) }
            } else {
                exchange.sendResponseHeaders(200, full.size.toLong())
                exchange.responseBody.use { it.write(full) }
            }
        }
        httpServer.start()

        try {
            val port = httpServer.address.port
            val transport = InMemoryBridgeTransport()
            transport.onServerReceive { rawJson ->
                val frame = JsonCodec.decodeMap(rawJson)
                if (frame["type"] == "attach") {
                    transport.sendToClient(
                        JsonCodec.encodeToString(
                            mapOf(
                                "type" to "attach-ack",
                                "protocol" to 1,
                                "clientSessionId" to "http-s",
                                "peerConnected" to true,
                                "hostInstanceId" to "http-h"
                            )
                        )
                    )
                } else if (frame["type"] == "worker-op") {
                    val id = frame["id"] as String
                    @Suppress("UNCHECKED_CAST")
                    val op = frame["op"] as Map<String, Any?>
                    when (op["method"]) {
                        "storage.putBytes", "storage.putPart", "storage.getBytes" -> transport.sendToClient(
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
                        "storage.beginUpload" -> {
                            val upId = "http-up-${storedByUpload.size + 1}"
                            val p = op["path"] as String
                            storedByUpload[upId] = ByteArray(0)
                            transport.sendToClient(
                                JsonCodec.encodeToString(
                                    mapOf(
                                        "type" to "worker-res",
                                        "id" to id,
                                        "ok" to true,
                                        "value" to mapOf(
                                            "uploadId" to upId,
                                            "uploadUrl" to "/__pyric/storage/upload/$upId",
                                            "path" to p
                                        )
                                    )
                                )
                            )
                        }
                        "storage.finishUpload" -> {
                            val upId = op["uploadId"] as String
                            val data = storedByUpload[upId] ?: ByteArray(0)
                            val objKey = if (data.isEmpty()) "zero.bin" else "http/data.bin"
                            committedObjects[objKey] = data
                            transport.sendToClient(
                                JsonCodec.encodeToString(
                                    mapOf(
                                        "type" to "worker-res",
                                        "id" to id,
                                        "ok" to true,
                                        "value" to mapOf(
                                            "bucket" to "http-bkt",
                                            "fullPath" to objKey,
                                            "name" to objKey.substringAfterLast('/'),
                                            "size" to data.size,
                                            "generation" to "1"
                                        )
                                    )
                                )
                            )
                        }
                        "storage.getMetadata" -> {
                            val p = op["path"] as String
                            val data = committedObjects[p] ?: ByteArray(0)
                            transport.sendToClient(
                                JsonCodec.encodeToString(
                                    mapOf(
                                        "type" to "worker-res",
                                        "id" to id,
                                        "ok" to true,
                                        "value" to mapOf(
                                            "bucket" to "http-bkt",
                                            "fullPath" to p,
                                            "name" to p.substringAfterLast('/'),
                                            "size" to data.size,
                                            "generation" to "1"
                                        )
                                    )
                                )
                            )
                        }
                    }
                }
            }

            val client = PyricBridgeClient(url = "ws://127.0.0.1:$port/__pyric/ws", directTransport = transport)
            val httpStorage = FirebaseStorage.getInstance(app, client, "gs://http-bkt")

            // 1. 300 KiB upload falls back from putBytes -> beginUpload -> HTTP PUT slices -> finishUpload
            val payload = ByteArray(300 * 1024) { ((it * 13 + 5) and 0xFF).toByte() }
            val snap = httpStorage.getReference("http/data.bin").putBytes(payload).await()
            assertEquals(payload.size.toLong(), snap.bytesTransferred)
            assertNotNull(snap.uploadSessionUri)

            // 2. 0-byte upload over HTTP byte route skips PUT and commits 0 bytes cleanly
            val zeroSnap = httpStorage.getReference("zero.bin").putBytes(ByteArray(0)).await()
            assertEquals(0L, zeroSnap.bytesTransferred)

            // 3. FileDownloadTask + getBytes maxDownloadSizeBytes overflow over HTTP byte route
            val dlOut = tempDir.resolve("http-dl.bin").toFile()
            httpStorage.getReference("http/data.bin").getFile(dlOut).await()
            assertArrayEquals(payload, dlOut.readBytes())

            val overEx = assertThrows(StorageException::class.java) {
                runBlocking { httpStorage.getReference("http/data.bin").getBytes(1024L).await() }
            }
            assertTrue(overEx.cause is IndexOutOfBoundsException)
        } finally {
            httpServer.stop(0)
        }
    }
}

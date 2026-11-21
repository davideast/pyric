package dev.pyric.e2e

import com.google.android.gms.tasks.await
import com.google.firebase.FirebaseApp
import com.google.firebase.FirebaseOptions
import com.google.firebase.auth.FirebaseAuth
import com.google.firebase.storage.FirebaseStorage
import com.google.firebase.storage.StorageException
import com.google.firebase.storage.StorageMetadata
import com.google.firebase.storage.TaskState
import com.google.firebase.storage.component1
import com.google.firebase.storage.component2
import com.google.firebase.storage.component3
import com.google.firebase.storage.component4
import com.google.firebase.storage.storageMetadata
import com.google.firebase.storage.taskState
import dev.pyric.bridge.PyricBridgeClient
import kotlinx.coroutines.flow.catch
import kotlinx.coroutines.flow.toList
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.tasks.await as ktxTaskAwait
import okhttp3.MediaType.Companion.toMediaTypeOrNull
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.junit.jupiter.api.AfterEach
import org.junit.jupiter.api.Assertions.assertArrayEquals
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertNotNull
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Assumptions
import org.junit.jupiter.api.BeforeEach
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.assertThrows
import org.junit.jupiter.api.io.TempDir
import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream
import java.io.InputStream
import java.net.URI
import java.nio.file.Path
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.atomic.AtomicBoolean

class StorageTasksLiveHostConformanceTest {

    private lateinit var liveBridgeUrl: String
    private lateinit var projectId: String
    private lateinit var defaultBucket: String
    private lateinit var customBucket: String
    private val bridges = mutableListOf<PyricBridgeClient>()
    private val httpClient = OkHttpClient.Builder().followRedirects(false).build()

    @BeforeEach
    fun setUp() {
        val envUrl = System.getenv("PYRIC_LIVE_STORAGE_BRIDGE_URL")
        Assumptions.assumeTrue(
            !envUrl.isNullOrBlank(),
            "Skipping StorageTasksLiveHostConformanceTest: PYRIC_LIVE_STORAGE_BRIDGE_URL is unset"
        )
        liveBridgeUrl = envUrl!!.trim()
        projectId = System.getenv("PYRIC_LIVE_STORAGE_PROJECT_ID")?.trim()
            ?.takeIf { it.isNotEmpty() }
            ?: "demo-kotlin-storage"
        defaultBucket = System.getenv("PYRIC_LIVE_STORAGE_DEFAULT_BUCKET")?.trim()
            ?.takeIf { it.isNotEmpty() }
            ?: "$projectId.appspot.com"
        customBucket = System.getenv("PYRIC_LIVE_STORAGE_CUSTOM_BUCKET")?.trim()
            ?.takeIf { it.isNotEmpty() }
            ?: "kotlin-custom-bucket"

        FirebaseStorage.clearInstancesForTest()
        FirebaseAuth.clearInstancesForTest()
        FirebaseApp.clearInstancesForTest()
    }

    @AfterEach
    fun tearDown() {
        for (bridge in bridges) {
            runCatching { bridge.terminate() }
        }
        bridges.clear()
        FirebaseStorage.clearInstancesForTest()
        FirebaseAuth.clearInstancesForTest()
        FirebaseApp.clearInstancesForTest()
    }

    private fun createAuthenticatedStorage(appName: String, email: String): Pair<FirebaseApp, FirebaseStorage> {
        val options = FirebaseOptions.Builder()
            .setProjectId(projectId)
            .setApiKey("sandbox-api-key")
            .setApplicationId("1:424242424242:android:kotlinstoragetasks")
            .setStorageBucket(defaultBucket)
            .build()
        val app = FirebaseApp.initializeApp(appName, options)
        val bridge = PyricBridgeClient(url = liveBridgeUrl)
        bridges.add(bridge)
        val auth = FirebaseAuth.getInstance(app, bridge)
        runBlocking {
            auth.createUserWithEmailAndPassword(email, "StrongPass!123").await()
        }
        val storage = FirebaseStorage.getInstance(app, bridge)
        return app to storage
    }

    @Test
    fun liveMultiChunkPutFileAndFileDownloadTaskRoundTripWithProgress(
        @TempDir tempDir: Path
    ) = runBlocking {
        val (_, storage) = createAuthenticatedStorage("live-pr2-file", "pr2-file@example.com")

        // 620 KiB payload > 256 KiB chunk boundary -> 3 HTTP byte-route slices + 3 ranged GETs
        val payload = ByteArray(620 * 1024) { idx -> ((idx * 43 + 17) and 0xFF).toByte() }
        val sourceFile = tempDir.resolve("source-620k.bin").toFile()
        sourceFile.writeBytes(payload)

        val ref = storage.getReference("pr2/multi-chunk/source-620k.bin")
        val uploadTask = ref.putFile(
            sourceFile.toURI(),
            storageMetadata {
                contentType = "application/x-pr2-binary"
                setCustomMetadata("origin", "putFile")
            }
        )

        val flowStates = uploadTask.taskState.toList()
        assertTrue(flowStates.size >= 3, "Expected multi-chunk TaskState.InProgress emissions")
        val (upTransferred, upTotal, upMeta, sessionUri) = uploadTask.await()
        assertEquals(payload.size.toLong(), upTransferred)
        assertEquals(payload.size.toLong(), upTotal)
        assertNotNull(sessionUri)
        assertEquals("http", sessionUri?.scheme)
        assertEquals("application/x-pr2-binary", upMeta?.contentType)
        assertEquals("putFile", upMeta?.getCustomMetadata("origin"))

        val downloadedFile = tempDir.resolve("downloaded-620k.bin").toFile()
        val dlProgress = CopyOnWriteArrayList<Long>()
        val fileTask = ref.getFile(downloadedFile)
        fileTask.addOnProgressListener { snap -> dlProgress.add(snap.bytesTransferred) }
        val (dlTransferred, dlTotal) = fileTask.await()
        assertEquals(payload.size.toLong(), dlTransferred)
        assertEquals(payload.size.toLong(), dlTotal)
        assertTrue(dlProgress.contains(256L * 1024L))
        assertArrayEquals(payload, downloadedFile.readBytes())
    }

    @Test
    fun livePutStreamZeroAvailableAndStreamDownloadTaskProcessorAndDirectStream() = runBlocking {
        val (app, defaultStorage) = createAuthenticatedStorage("live-pr2-stream", "pr2-stream@example.com")
        val customStorage = FirebaseStorage.getInstance(app, defaultStorage.bridgeClient, "gs://$customBucket")

        val streamPayload = ByteArray(310 * 1024) { idx -> ((idx * 61 + 29) and 0xFF).toByte() }
        val closed = AtomicBoolean(false)
        val zeroAvailStream = object : InputStream() {
            private val inner = ByteArrayInputStream(streamPayload)
            override fun available(): Int = 0
            override fun read(): Int = inner.read()
            override fun read(b: ByteArray, off: Int, len: Int): Int =
                inner.read(b, off, minOf(len, 8192))
            override fun close() {
                closed.set(true)
                inner.close()
            }
        }

        val customRef = customStorage.getReference("pr2-custom/streamed.bin")
        val streamUploadSnap = customRef.putStream(
            zeroAvailStream,
            storageMetadata { contentType = "application/octet-stream" }
        ).ktxTaskAwait()
        assertTrue(closed.get())
        assertEquals(customBucket, streamUploadSnap.metadata?.bucket)

        // Processor-based StreamDownloadTask
        val processorOut = ByteArrayOutputStream()
        val (stTransferred, stTotal, _) = customRef.getStream { _, inputStream ->
            inputStream.copyTo(processorOut, bufferSize = 32 * 1024)
        }.await()
        assertEquals(streamPayload.size.toLong(), stTransferred)
        assertEquals(streamPayload.size.toLong(), stTotal)
        assertArrayEquals(streamPayload, processorOut.toByteArray())

        // Direct InputStream on TaskSnapshot
        val directStreamRead = customRef.getStream().await().stream.use { it.readBytes() }
        assertArrayEquals(streamPayload, directStreamRead)
    }

    @Test
    fun livePutFileResumesFromExistingUploadSessionUriOffset(
        @TempDir tempDir: Path
    ) = runBlocking {
        val (_, storage) = createAuthenticatedStorage("live-pr2-resume", "pr2-resume@example.com")

        val resumePayload = ByteArray(300 * 1024) { idx -> ((idx * 13 + 7) and 0xFF).toByte() }
        val resumeLocalFile = tempDir.resolve("resume-300k.bin").toFile()
        resumeLocalFile.writeBytes(resumePayload)

        val resumeRef = storage.getReference("pr2/resumed-session.bin")
        @Suppress("UNCHECKED_CAST")
        val beginRaw = storage.bridgeClient.op(
            method = "storage.beginUpload",
            params = mapOf(
                "path" to "pr2/resumed-session.bin",
                "size" to resumePayload.size,
                "contentType" to "application/octet-stream",
                "defaultBucket" to defaultBucket
            ),
            actAs = storage.getEffectiveAuthLens().toMap()
        ) as Map<String, Any?>

        val rawUploadUrl = beginRaw["uploadUrl"] as String
        val bridgeUri = URI.create(liveBridgeUrl)
        val sessionUrl = "http://${bridgeUri.rawAuthority}$rawUploadUrl"

        val firstSliceLen = 100 * 1024
        val prePutReq = Request.Builder()
            .url(sessionUrl)
            .put(resumePayload.toRequestBody("application/octet-stream".toMediaTypeOrNull(), 0, firstSliceLen))
            .header("Content-Range", "bytes 0-${firstSliceLen - 1}/${resumePayload.size}")
            .header("x-pyric-byte-route", "1")
            .build()
        httpClient.newCall(prePutReq).execute().use { resp ->
            assertEquals(308, resp.code)
        }

        // Resume via putFile(uri, metadata, existingUploadUri) -- probes 100 KiB offset and sends remaining 200 KiB
        val resumedStates = CopyOnWriteArrayList<Long>()
        val resumedTask = resumeRef.putFile(
            resumeLocalFile.toURI(),
            storageMetadata { contentType = "application/octet-stream" },
            URI.create(sessionUrl)
        )
        resumedTask.addOnProgressListener { snap ->
            if (snap.bytesTransferred > 0L) {
                resumedStates.add(snap.bytesTransferred)
            }
        }
        val resumedSnap = resumedTask.await()
        assertEquals(resumePayload.size.toLong(), resumedSnap.bytesTransferred)
        assertTrue(resumedStates.first() >= firstSliceLen.toLong())
        assertArrayEquals(resumePayload, resumeRef.getBytes(512L * 1024L).await())
    }

    @Test
    fun liveUpdateMetadataCustomKeyClearingAndMaxDownloadSizeOverflow() = runBlocking {
        val (_, storage) = createAuthenticatedStorage("live-pr2-meta", "pr2-meta@example.com")
        val ref = storage.getReference("pr2/metadata/config.json")
        val rawBytes = ByteArray(16 * 1024) { idx -> ((idx * 19 + 3) and 0xFF).toByte() }

        ref.putBytes(
            rawBytes,
            storageMetadata {
                contentType = "application/octet-stream"
                cacheControl = "max-age=60"
                setCustomMetadata("keep", "initial")
                setCustomMetadata("drop", "obsolete")
            }
        ).await()

        val updated = ref.updateMetadata(
            StorageMetadata.Builder()
                .setCacheControl(null)
                .setCustomMetadata("keep", "updated")
                .setCustomMetadata("drop", null)
                .setCustomMetadata("added", "fresh")
                .build()
        ).await()

        assertNull(updated.cacheControl)
        assertEquals("updated", updated.getCustomMetadata("keep"))
        assertNull(updated.getCustomMetadata("drop"))
        assertEquals("fresh", updated.getCustomMetadata("added"))
        assertEquals(setOf("keep", "added"), updated.customMetadataKeys)

        val overflowEx = assertThrows<StorageException> {
            ref.getBytes(4096L).await()
        }
        assertEquals(StorageException.ERROR_UNKNOWN, overflowEx.errorCode)
        assertTrue(overflowEx.cause is IndexOutOfBoundsException)
        assertArrayEquals(rawBytes, ref.getBytes(16L * 1024L).await())
    }

    @Test
    fun livePaginatedListOrderingAndNonDefaultBucketIsolation() = runBlocking {
        val (app, defaultStorage) = createAuthenticatedStorage("live-pr2-list", "pr2-list@example.com")
        val secondaryStorage = FirebaseStorage.getInstance(app, defaultStorage.bridgeClient, "gs://$customBucket")

        val entries = listOf(
            "pr2-page/a.txt",
            "pr2-page/b-sub/one.txt",
            "pr2-page/c.txt",
            "pr2-page/d-sub/two.txt",
            "pr2-page/e.txt"
        )
        for (p in entries) {
            defaultStorage.getReference(p).putBytes(byteArrayOf(42)).await()
        }
        secondaryStorage.getReference("pr2-page/a.txt").putBytes(byteArrayOf(99)).await()

        val folder = defaultStorage.getReference("pr2-page")
        val p1 = folder.list(2).await()
        assertEquals(listOf("a.txt"), p1.items.map { it.name })
        assertEquals(listOf("b-sub"), p1.prefixes.map { it.name })
        assertNotNull(p1.pageToken)

        val p2 = folder.list(2, p1.pageToken!!).await()
        assertEquals(listOf("c.txt"), p2.items.map { it.name })
        assertEquals(listOf("d-sub"), p2.prefixes.map { it.name })
        assertNotNull(p2.pageToken)

        val p3 = folder.list(2, p2.pageToken!!).await()
        assertEquals(listOf("e.txt"), p3.items.map { it.name })
        assertTrue(p3.prefixes.isEmpty())
        assertNull(p3.pageToken)

        assertArrayEquals(byteArrayOf(42), defaultStorage.getReference("pr2-page/a.txt").getBytes(64L).await())
        assertArrayEquals(byteArrayOf(99), secondaryStorage.getReference("pr2-page/a.txt").getBytes(64L).await())
    }

    @Test
    fun liveTaskStateFlowErrorPropagationAndZeroByteTransfers(
        @TempDir tempDir: Path
    ) = runBlocking {
        val (_, storage) = createAuthenticatedStorage("live-pr2-flow-err", "pr2-flow-err@example.com")

        // Missing object download propagates StorageException(ERROR_OBJECT_NOT_FOUND) to Flow.catch
        val missingDest = tempDir.resolve("missing.bin").toFile()
        val caught = CopyOnWriteArrayList<Throwable>()
        storage.getReference("pr2/does-not-exist.bin")
            .getFile(missingDest)
            .taskState
            .catch { err -> caught.add(err) }
            .toList()
        assertEquals(1, caught.size)
        assertEquals(StorageException.ERROR_OBJECT_NOT_FOUND, (caught.single() as StorageException).errorCode)

        // 0-byte empty object round-trip via putStream + getFile + getStream on HostedRuntime
        val zeroRef = storage.getReference("pr2/zero-empty.bin")
        val zeroUp = zeroRef.putStream(ByteArrayInputStream(ByteArray(0))).await()
        assertEquals(0L, zeroUp.bytesTransferred)
        assertEquals(0L, zeroUp.totalByteCount)

        val zeroOut = tempDir.resolve("zero-out.bin").toFile()
        val zeroDl = zeroRef.getFile(zeroOut).await()
        assertEquals(0L, zeroDl.bytesTransferred)
        assertEquals(0, zeroOut.readBytes().size)
    }
}

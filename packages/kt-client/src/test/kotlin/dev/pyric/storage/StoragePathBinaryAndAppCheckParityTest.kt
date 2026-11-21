package dev.pyric.storage

import com.google.android.gms.tasks.await
import com.google.firebase.FirebaseApp
import com.google.firebase.FirebaseOptions
import com.google.firebase.appcheck.FirebaseAppCheck
import com.google.firebase.appcheck.debug.DebugAppCheckProviderFactory
import com.google.firebase.appcheck.playintegrity.PlayIntegrityAppCheckProviderFactory
import com.google.firebase.auth.FirebaseAuth
import com.google.firebase.storage.FirebaseStorage
import com.google.firebase.storage.StorageException
import com.google.firebase.storage.StorageMetadata
import com.google.firebase.storage.storageMetadata
import kotlinx.coroutines.runBlocking
import org.junit.jupiter.api.AfterEach
import org.junit.jupiter.api.Assertions.assertArrayEquals
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertNotNull
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.BeforeEach
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.assertThrows
import org.junit.jupiter.api.io.TempDir
import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream
import java.net.URI
import java.net.URLEncoder
import java.nio.charset.StandardCharsets
import java.nio.file.Path

class StoragePathBinaryAndAppCheckParityTest {
    private val mockHarnesses = mutableListOf<StorageMockBridgeHarness>()
    private val loopbackServers = mutableListOf<StorageLoopbackByteRouteServer>()

    private fun newMockHarness(): StorageMockBridgeHarness =
        StorageMockBridgeHarness().also { mockHarnesses.add(it) }

    private fun newLoopbackServer(): StorageLoopbackByteRouteServer =
        StorageLoopbackByteRouteServer().also { loopbackServers.add(it) }

    @BeforeEach
    fun setUp() {
        FirebaseStorage.clearInstancesForTest()
        FirebaseAuth.clearInstancesForTest()
        FirebaseAppCheck.clearInstancesForTest()
        FirebaseApp.clearInstancesForTest()
    }

    @AfterEach
    fun tearDown() {
        mockHarnesses.forEach { it.closeAll() }
        mockHarnesses.clear()
        loopbackServers.forEach { it.close() }
        loopbackServers.clear()
        FirebaseStorage.clearInstancesForTest()
        FirebaseAuth.clearInstancesForTest()
        FirebaseAppCheck.clearInstancesForTest()
        FirebaseApp.clearInstancesForTest()
    }

    private fun createApp(name: String, bucket: String = "parity-bucket.appspot.com"): FirebaseApp {
        val options = FirebaseOptions.Builder()
            .setProjectId("parity-project")
            .setApiKey("parity-api-key")
            .setApplicationId("1:424242424242:android:parity")
            .setStorageBucket(bucket)
            .build()
        return FirebaseApp.initializeApp(name, options)
    }

    @Test
    fun zeroByteEmptyObjectRoundTripsAcrossPutBytesPutStreamPutFileGetBytesGetFileAndStream(
        @TempDir tempDir: Path
    ): Unit = runBlocking {
        val server = newLoopbackServer()
        val app = createApp("zero-byte-app")
        val storage = FirebaseStorage.getInstance(app, server.newBridgeClient())

        val bytesRef = storage.getReference("empty/via-bytes.bin")
        val bytesSnap = bytesRef.putBytes(
            ByteArray(0),
            storageMetadata {
                contentType = "application/x-empty"
                setCustomMetadata("kind", "zero")
            }
        ).await()
        assertEquals(0L, bytesSnap.bytesTransferred)
        assertEquals(0L, bytesSnap.totalByteCount)
        assertEquals("1B2M2Y8AsgTpgAmY7PhCfg==", bytesSnap.metadata?.md5Hash)
        assertEquals(0, bytesRef.getBytes(1L).await().size)

        val updatedMeta = bytesRef.updateMetadata(
            StorageMetadata.Builder().setCustomMetadata("kind", "zero-updated").build()
        ).await()
        assertEquals(0L, updatedMeta.sizeBytes)
        assertEquals("zero-updated", updatedMeta.getCustomMetadata("kind"))

        val emptySource = tempDir.resolve("empty-in.bin").toFile().apply { writeBytes(ByteArray(0)) }
        val fileRef = storage.getReference("empty/via-file.bin")
        val fileUpSnap = fileRef.putFile(emptySource.toURI()).await()
        assertEquals(0L, fileUpSnap.totalByteCount)

        val emptyDest = tempDir.resolve("empty-out.bin").toFile()
        val fileDlSnap = fileRef.getFile(emptyDest).await()
        assertEquals(0L, fileDlSnap.bytesTransferred)
        assertEquals(0L, fileDlSnap.totalByteCount)
        assertEquals(0, emptyDest.readBytes().size)

        val streamRef = storage.getReference("empty/via-stream.bin")
        streamRef.putStream(ByteArrayInputStream(ByteArray(0))).await()
        val directRead = streamRef.getStream().await().stream.use { it.readBytes() }
        assertEquals(0, directRead.size)

        val processorOut = ByteArrayOutputStream()
        streamRef.getStream { _, input -> input.copyTo(processorOut) }.await()
        assertEquals(0, processorOut.size())
    }

    @Test
    fun fullByteSpectrum0x00To0xFFAndExact256KiBBoundaryPreserveEveryByte(
        @TempDir tempDir: Path
    ): Unit = runBlocking {
        val server = newLoopbackServer()
        val app = createApp("binary-boundary-app")
        val storage = FirebaseStorage.getInstance(app, server.newBridgeClient())

        val fullSpectrum = ByteArray(4096) { idx -> (idx and 0xFF).toByte() }
        val spectrumRef = storage.getReference("binary/spectrum-00-ff.bin")
        spectrumRef.putBytes(fullSpectrum).await()
        assertArrayEquals(fullSpectrum, spectrumRef.getBytes(8192L).await())

        val exactChunk = ByteArray(256 * 1024) { idx -> ((idx * 31 + 0x80) and 0xFF).toByte() }
        val exactRef = storage.getReference("binary/exact-256k.bin")
        exactRef.putStream(ByteArrayInputStream(exactChunk)).await()
        val exactStreamed = exactRef.getStream().await().stream.use { it.readBytes() }
        assertArrayEquals(exactChunk, exactStreamed)

        val plusOneChunk = ByteArray(256 * 1024 + 1) { idx -> ((idx * 17 + 255) and 0xFF).toByte() }
        val plusOneSource = tempDir.resolve("boundary-plus-one.bin").toFile().apply { writeBytes(plusOneChunk) }
        val plusOneDest = tempDir.resolve("boundary-plus-one-out.bin").toFile()
        val plusOneRef = storage.getReference("binary/boundary-256k-plus-1.bin")
        plusOneRef.putFile(plusOneSource.toURI()).await()
        plusOneRef.getFile(plusOneDest).await()
        assertArrayEquals(plusOneChunk, plusOneDest.readBytes())
    }

    @Test
    fun unicodeAccentedCjkSurrogateAndReservedCharactersNormalizeAcrossChildAndUrlParsers(): Unit = runBlocking {
        val harness = newMockHarness()
        val app = createApp("unicode-url-app", "unicode-bucket.firebasestorage.app")
        val storage = FirebaseStorage.getInstance(app, harness.newBridgeClient())

        val messyPath = "//caf\u00e9//\u6771\u4eac \ud83d\ude80///report a+b%25#frag?v=1&x=2.bin//"
        val expectedWire = "caf\u00e9/\u6771\u4eac \ud83d\ude80/report a+b%25#frag?v=1&x=2.bin"
        val refViaGet = storage.getReference(messyPath)
        val refViaChild = storage.reference
            .child("///caf\u00e9/")
            .child("//\u6771\u4eac \ud83d\ude80//")
            .child("/report a+b%25#frag?v=1&x=2.bin///")

        assertEquals("/$expectedWire", refViaGet.path)
        assertEquals("report a+b%25#frag?v=1&x=2.bin", refViaGet.name)
        assertEquals("/caf\u00e9/\u6771\u4eac \ud83d\ude80", refViaGet.parent?.path)
        assertEquals("\u6771\u4eac \ud83d\ude80", refViaGet.parent?.name)
        assertEquals(refViaGet, refViaChild)
        assertEquals("gs://unicode-bucket.firebasestorage.app/$expectedWire", refViaGet.toString())

        val payload = byteArrayOf(0x00, 0x41, 0x7F, 0x80.toByte(), 0xFF.toByte())
        refViaGet.putBytes(payload).await()

        val downloadUri = refViaGet.getDownloadUrl().await()
        val fromPyricDownload = storage.getReferenceFromUrl(downloadUri.toString())
        assertEquals(refViaGet, fromPyricDownload)

        val encodedFullObject = URLEncoder.encode(expectedWire, StandardCharsets.UTF_8.name())
            .replace("+", "%20")
        val encodedSegments = expectedWire.split('/').joinToString("/") { seg ->
            URLEncoder.encode(seg, StandardCharsets.UTF_8.name()).replace("+", "%20")
        }

        val fromGs = storage.getReferenceFromUrl(refViaGet.toString())
        val fromFirebaseHttp = storage.getReferenceFromUrl(
            "https://firebasestorage.googleapis.com/v0/b/unicode-bucket.firebasestorage.app/o/$encodedFullObject?alt=media&token=t1"
        )
        val fromGcsHttp = storage.getReferenceFromUrl(
            "https://storage.googleapis.com/unicode-bucket.firebasestorage.app/$encodedSegments?generation=1#meta"
        )
        val fromCloudHttp = storage.getReferenceFromUrl(
            "https://storage.cloud.google.com/unicode-bucket.firebasestorage.app/$encodedSegments"
        )
        val fromEmulatorHttp = storage.getReferenceFromUrl(
            "http://10.0.2.2:9199/v0/b/unicode-bucket.firebasestorage.app/o/$encodedFullObject?alt=media"
        )

        assertEquals(refViaGet, fromGs)
        assertEquals(refViaGet, fromFirebaseHttp)
        assertEquals(refViaGet, fromGcsHttp)
        assertEquals(refViaGet, fromCloudHttp)
        assertEquals(refViaGet, fromEmulatorHttp)
        assertArrayEquals(payload, fromFirebaseHttp.getBytes(64L).await())
    }

    @Test
    fun httpByteRouteAttachesAppCheckAndSessionTokenHeadersOnUploadProbeAndDownload(
        @TempDir tempDir: Path
    ): Unit = runBlocking {
        val server = newLoopbackServer()
        server.currentAppCheckJwt = "debug-jwt"
        val app = createApp("byte-route-appcheck-app")
        val bridge = server.newBridgeClient(querySuffix = "?token=query-sess-token-77")

        val appCheck = FirebaseAppCheck.getInstance(app, bridge)
        appCheck.installAppCheckProviderFactory(DebugAppCheckProviderFactory.getInstance(), false)
        val storage = FirebaseStorage.getInstance(app, bridge)

        val payload = ByteArray(300 * 1024) { idx -> ((idx * 23 + 5) and 0xFF).toByte() }
        val srcFile = tempDir.resolve("appcheck-300k.bin").toFile().apply { writeBytes(payload) }
        val dstFile = tempDir.resolve("appcheck-300k-out.bin").toFile()

        val ref = storage.getReference("protected/appcheck-300k.bin")
        val upSnap = ref.putFile(srcFile.toURI()).await()
        assertNotNull(upSnap.uploadSessionUri)

        // Open a fresh staged session to verify existingUploadUri offset probe + chunk transfer headers
        @Suppress("UNCHECKED_CAST")
        val beginMap = bridge.op(
            method = "storage.beginUpload",
            params = mapOf(
                "path" to "protected/resumed-300k.bin",
                "size" to payload.size,
                "defaultBucket" to "parity-bucket.appspot.com"
            )
        ) as Map<String, Any?>
        val openSessionUri = URI.create("${server.baseHttpOrigin}${beginMap["uploadUrl"] as String}")
        val resumedRef = storage.getReference("protected/resumed-300k.bin")
        val resumedSnap = resumedRef.putFile(
            srcFile.toURI(),
            storageMetadata { contentType = "application/octet-stream" },
            openSessionUri
        ).await()
        assertEquals(payload.size.toLong(), resumedSnap.bytesTransferred)

        assertArrayEquals(payload, ref.getBytes(512L * 1024L).await())
        ref.getFile(dstFile).await()
        assertArrayEquals(payload, dstFile.readBytes())

        val storageWsOps = server.recordedWsOps.filter { (it["method"] as? String)?.startsWith("storage.") == true }
        assertTrue(storageWsOps.isNotEmpty())
        for (op in storageWsOps) {
            val attached = op["appCheckToken"] as? String
            assertEquals("debug-jwt-1", attached, "Expected WS op ${op["method"]} to carry App Check JWT")
        }

        assertTrue(server.capturedHttpRequests.size >= 5)
        for (httpReq in server.capturedHttpRequests) {
            assertEquals("1", httpReq.headers["x-pyric-byte-route"])
            assertEquals("query-sess-token-77", httpReq.headers["x-pyric-session-token"])
            assertEquals("debug-jwt-1", httpReq.headers["x-firebase-appcheck"])
        }
    }

    @Test
    fun withoutAppCheckProviderByteRouteOmitsAppCheckHeaderAndUpdatesAfterProviderInstall(): Unit = runBlocking {
        val server = newLoopbackServer()
        server.currentAppCheckJwt = "play-jwt"
        val app = createApp("optional-appcheck-app")
        val bridge = server.newBridgeClient(headers = mapOf("x-pyric-session-token" to "header-sess-99"))
        val storage = FirebaseStorage.getInstance(app, bridge)

        val ref = storage.getReference("optional/item.bin")
        ref.putBytes(byteArrayOf(1, 2, 3, 4)).await()
        assertArrayEquals(byteArrayOf(1, 2, 3, 4), ref.getBytes(16L).await())

        for (reqBefore in server.capturedHttpRequests) {
            assertNull(reqBefore.headers["x-firebase-appcheck"])
            assertEquals("header-sess-99", reqBefore.headers["x-pyric-session-token"])
        }

        server.capturedHttpRequests.clear()
        val appCheck = FirebaseAppCheck.getInstance(app, bridge)
        appCheck.installAppCheckProviderFactory(PlayIntegrityAppCheckProviderFactory.getInstance(), false)

        ref.putBytes(byteArrayOf(9, 8, 7)).await()
        assertArrayEquals(byteArrayOf(9, 8, 7), ref.getBytes(16L).await())
        assertFalse(server.capturedHttpRequests.isEmpty())
        for (reqAfter in server.capturedHttpRequests) {
            assertEquals("play-jwt-1", reqAfter.headers["x-firebase-appcheck"])
        }
    }

    @Test
    fun httpByteRouteStatusCodesMapToUpstreamStorageExceptionCodes(): Unit = runBlocking {
        val server = newLoopbackServer()
        val app = createApp("status-map-app")
        val storage = FirebaseStorage.getInstance(app, server.newBridgeClient())
        val ref = storage.getReference("errors/target.bin")
        ref.putBytes(byteArrayOf(10, 20, 30)).await()

        val expectedDownloadMappings = listOf(
            401 to StorageException.ERROR_NOT_AUTHENTICATED,
            403 to StorageException.ERROR_NOT_AUTHORIZED,
            404 to StorageException.ERROR_OBJECT_NOT_FOUND,
            409 to StorageException.ERROR_INVALID_CHECKSUM,
            413 to StorageException.ERROR_QUOTA_EXCEEDED,
            503 to StorageException.ERROR_RETRY_LIMIT_EXCEEDED,
            500 to StorageException.ERROR_UNKNOWN
        )

        for ((httpCode, expectedErrorCode) in expectedDownloadMappings) {
            server.queuedHttpStatuses.add(httpCode)
            val ex = assertThrows<StorageException> {
                ref.getBytes(64L).await()
            }
            assertEquals(expectedErrorCode, ex.errorCode, "Mismatch for HTTP $httpCode")
            assertEquals(httpCode, ex.httpResultCode)
            assertEquals(httpCode == 503, ex.isRecoverableException)
        }

        // Upload slice 413 maps to ERROR_QUOTA_EXCEEDED and aborts staged upload
        server.queuedHttpStatuses.add(413)
        val upEx = assertThrows<StorageException> {
            storage.getReference("errors/quota.bin").putBytes(ByteArray(1024) { 1 }).await()
        }
        assertEquals(StorageException.ERROR_QUOTA_EXCEEDED, upEx.errorCode)
    }

    @Test
    fun httpByteRouteDownloadRetriesSingle412GenerationMismatchAndFailsRepeated412(
        @TempDir tempDir: Path
    ): Unit = runBlocking {
        val server = newLoopbackServer()
        val app = createApp("gen-412-app")
        val storage = FirebaseStorage.getInstance(app, server.newBridgeClient())
        val ref = storage.getReference("gen/changing.bin")
        val content = byteArrayOf(5, 10, 15, 20, 25)
        ref.putBytes(content).await()

        // Single 412 caused by generation bump between getMetadata and HTTP GET retries cleanly
        server.mutateGenerationBeforeFirstHttpGet = true
        assertArrayEquals(content, ref.getBytes(64L).await())

        // Persistent 412 across both attempts surfaces ERROR_RETRY_LIMIT_EXCEEDED
        server.queuedHttpStatuses.add(412)
        server.queuedHttpStatuses.add(412)
        val retryEx = assertThrows<StorageException> {
            ref.getBytes(64L).await()
        }
        assertEquals(StorageException.ERROR_RETRY_LIMIT_EXCEEDED, retryEx.errorCode)

        // Ranged download (FileDownloadTask) encountering 412 surfaces ERROR_INVALID_CHECKSUM
        server.queuedHttpStatuses.add(412)
        val rangedEx = assertThrows<StorageException> {
            ref.getFile(tempDir.resolve("changing-out.bin").toFile()).await()
        }
        assertEquals(StorageException.ERROR_INVALID_CHECKSUM, rangedEx.errorCode)
        assertEquals(412, rangedEx.httpResultCode)
    }

    @Test
    fun listAllAndPaginatedListHandleUnicodeSpacesAndSpecialCharacterPrefixes(): Unit = runBlocking {
        val harness = newMockHarness()
        val app = createApp("unicode-list-app")
        val storage = FirebaseStorage.getInstance(app, harness.newBridgeClient())

        val objectPaths = listOf(
            " root-trim /a + 1.txt",
            "root-trim/caf\u00e9 #2.txt",
            "root-trim/sub \u6771\u4eac/nested.bin",
            "root-trim/z%25final.txt"
        )
        // First entry has spaces around folder name (" root-trim "), verify distinct vs "root-trim"
        for (p in objectPaths) {
            storage.getReference(p).putBytes(byteArrayOf(1)).await()
        }

        val folder = storage.getReference("//root-trim///")
        val all = folder.listAll().await()
        assertEquals(listOf("caf\u00e9 #2.txt", "z%25final.txt"), all.items.map { it.name })
        assertEquals(listOf("sub \u6771\u4eac"), all.prefixes.map { it.name })

        val page1 = folder.list(2).await()
        assertNotNull(page1.pageToken)
        val page2 = folder.list(2, page1.pageToken!!).await()
        assertNull(page2.pageToken)
        assertEquals(3, page1.items.size + page1.prefixes.size + page2.items.size + page2.prefixes.size)
    }
}

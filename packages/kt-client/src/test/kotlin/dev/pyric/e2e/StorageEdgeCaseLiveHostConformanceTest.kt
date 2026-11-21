package dev.pyric.e2e

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
import dev.pyric.bridge.PyricBridgeClient
import kotlinx.coroutines.runBlocking
import okhttp3.OkHttpClient
import okhttp3.Request
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
import java.nio.file.Path

class StorageEdgeCaseLiveHostConformanceTest {

    private lateinit var liveBridgeUrl: String
    private lateinit var projectId: String
    private lateinit var defaultBucket: String
    private lateinit var customBucket: String
    private lateinit var liveAppId: String
    private val bridges = mutableListOf<PyricBridgeClient>()
    private val httpClient = OkHttpClient.Builder().followRedirects(false).build()

    @BeforeEach
    fun setUp() {
        val envUrl = System.getenv("PYRIC_LIVE_STORAGE_BRIDGE_URL")
        Assumptions.assumeTrue(
            !envUrl.isNullOrBlank(),
            "Skipping StorageEdgeCaseLiveHostConformanceTest: PYRIC_LIVE_STORAGE_BRIDGE_URL is unset"
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
        liveAppId = System.getenv("PYRIC_LIVE_STORAGE_APP_ID")?.trim()
            ?.takeIf { it.isNotEmpty() }
            ?: "1:424242424242:android:kotlinstorage"

        FirebaseStorage.clearInstancesForTest()
        FirebaseAuth.clearInstancesForTest()
        FirebaseAppCheck.clearInstancesForTest()
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
        FirebaseAppCheck.clearInstancesForTest()
        FirebaseApp.clearInstancesForTest()
    }

    private fun createAuthenticatedStorage(
        appName: String,
        email: String,
        installDebugAppCheck: Boolean = false
    ): Triple<FirebaseApp, PyricBridgeClient, FirebaseStorage> {
        val options = FirebaseOptions.Builder()
            .setProjectId(projectId)
            .setApiKey("sandbox-api-key")
            .setApplicationId(liveAppId)
            .setStorageBucket(defaultBucket)
            .build()
        val app = FirebaseApp.initializeApp(appName, options)
        val bridge = PyricBridgeClient(url = liveBridgeUrl)
        bridges.add(bridge)

        if (installDebugAppCheck) {
            val appCheck = FirebaseAppCheck.getInstance(app, bridge)
            appCheck.installAppCheckProviderFactory(DebugAppCheckProviderFactory.getInstance(), false)
        }

        val auth = FirebaseAuth.getInstance(app, bridge)
        runBlocking {
            auth.createUserWithEmailAndPassword(email, "StrongEdgePass!123").await()
        }
        val storage = FirebaseStorage.getInstance(app, bridge)
        return Triple(app, bridge, storage)
    }

    @Test
    fun liveZeroByteEmptyObjectRoundTripsAcrossBytesFileStreamDownloadUrlAndMetadata(
        @TempDir tempDir: Path
    ): Unit = runBlocking {
        val (_, _, storage) = createAuthenticatedStorage("live-pr3-zero", "pr3-zero@example.com")

        val ref = storage.getReference("pr3/empty/zero-bytes.bin")
        val upSnap = ref.putBytes(
            ByteArray(0),
            storageMetadata {
                contentType = "application/x-empty"
                setCustomMetadata("stage", "initial")
            }
        ).await()
        assertEquals(0L, upSnap.bytesTransferred)
        assertEquals(0L, upSnap.totalByteCount)
        assertEquals(0L, upSnap.metadata?.sizeBytes)

        assertEquals(0, ref.getBytes(128L).await().size)

        val updated = ref.updateMetadata(
            StorageMetadata.Builder().setCustomMetadata("stage", "patched").build()
        ).await()
        assertEquals(0L, updated.sizeBytes)
        assertEquals("patched", updated.getCustomMetadata("stage"))

        val downloadUri = ref.getDownloadUrl().await()
        httpClient.newCall(Request.Builder().url(downloadUri.toURL()).get().build()).execute().use { resp ->
            assertEquals(200, resp.code)
            assertEquals("0", resp.header("Content-Length"))
            assertEquals(0, (resp.body?.bytes() ?: ByteArray(0)).size)
        }

        val emptyIn = tempDir.resolve("live-zero-in.bin").toFile().apply { writeBytes(ByteArray(0)) }
        val emptyOut = tempDir.resolve("live-zero-out.bin").toFile()
        val fileRef = storage.getReference("pr3/empty/zero-file.bin")
        fileRef.putFile(emptyIn.toURI()).await()
        fileRef.getFile(emptyOut).await()
        assertEquals(0, emptyOut.readBytes().size)

        val streamedBytes = fileRef.getStream().await().stream.use { it.readBytes() }
        assertEquals(0, streamedBytes.size)
    }

    @Test
    fun liveUnicodeSpacesSlashesAndReservedCharPathsRoundTripAndListCleanly(): Unit = runBlocking {
        val (_, _, storage) = createAuthenticatedStorage("live-pr3-unicode", "pr3-unicode@example.com")

        val unnormalized = "///pr3-unicode//caf\u00e9 \u6771\u4eac \ud83d\ude80///note a+b%25#tag?q=1.txt//"
        val expectedPath = "/pr3-unicode/caf\u00e9 \u6771\u4eac \ud83d\ude80/note a+b%25#tag?q=1.txt"
        val ref = storage.getReference(unnormalized)
        assertEquals(expectedPath, ref.path)
        assertEquals("note a+b%25#tag?q=1.txt", ref.name)

        val payload = "unicode-live-payload-\u00e9-\u6771\u4eac".toByteArray(Charsets.UTF_8)
        ref.putBytes(payload, storageMetadata { contentType = "text/plain; charset=utf-8" }).await()

        val fetched = ref.getBytes(1024L).await()
        assertArrayEquals(payload, fetched)

        val downloadUri = ref.getDownloadUrl().await()
        httpClient.newCall(Request.Builder().url(downloadUri.toURL()).get().build()).execute().use { resp ->
            assertEquals(200, resp.code)
            assertArrayEquals(payload, resp.body?.bytes())
        }

        val parsedFromDownload = storage.getReferenceFromUrl(downloadUri.toString())
        assertEquals(ref, parsedFromDownload)
        assertEquals(ref, storage.getReferenceFromUrl(ref.toString()))
        assertArrayEquals(payload, parsedFromDownload.getBytes(1024L).await())

        val sibling = storage.reference
            .child("//pr3-unicode//")
            .child("caf\u00e9 \u6771\u4eac \ud83d\ude80")
            .child("second file.txt")
        sibling.putBytes(byteArrayOf(7, 8, 9)).await()

        val parentFolder = ref.parent!!
        val listed = parentFolder.listAll().await()
        assertEquals(
            listOf("note a+b%25#tag?q=1.txt", "second file.txt"),
            listed.items.map { it.name }
        )

        val page1 = parentFolder.list(1).await()
        assertEquals(1, page1.items.size)
        assertNotNull(page1.pageToken)
        val page2 = parentFolder.list(1, page1.pageToken!!).await()
        assertEquals(1, page2.items.size)
        assertNull(page2.pageToken)

        ref.delete().await()
        val afterDeleteEx = assertThrows<StorageException> { ref.getMetadata().await() }
        assertEquals(StorageException.ERROR_OBJECT_NOT_FOUND, afterDeleteEx.errorCode)
    }

    @Test
    fun liveFullByteSpectrumAndMultiChunk540KiBBinaryIntegrityAcrossAllApis(
        @TempDir tempDir: Path
    ): Unit = runBlocking {
        val (_, _, storage) = createAuthenticatedStorage("live-pr3-binary", "pr3-binary@example.com")

        // 540 KiB (> 2 * 256 KiB chunks) cycling all 256 byte values 0x00..0xFF with deterministic mixing
        val binaryPayload = ByteArray(540 * 1024) { idx ->
            if (idx < 256) idx.toByte() else ((idx * 73 + (idx ushr 8)) and 0xFF).toByte()
        }

        val bytesRef = storage.getReference("pr3/binary/spectrum-540k-bytes.bin")
        val bytesMeta = bytesRef.putBytes(binaryPayload).await().metadata
        assertNotNull(bytesMeta?.md5Hash)
        assertArrayEquals(binaryPayload, bytesRef.getBytes(1024L * 1024L).await())

        val streamRef = storage.getReference("pr3/binary/spectrum-540k-stream.bin")
        val streamMeta = streamRef.putStream(ByteArrayInputStream(binaryPayload)).await().metadata
        assertEquals(bytesMeta?.md5Hash, streamMeta?.md5Hash)

        val destFile = tempDir.resolve("spectrum-540k-out.bin").toFile()
        streamRef.getFile(destFile).await()
        assertArrayEquals(binaryPayload, destFile.readBytes())

        val processorOut = ByteArrayOutputStream(binaryPayload.size)
        streamRef.getStream { _, input -> input.copyTo(processorOut, bufferSize = 64 * 1024) }.await()
        assertArrayEquals(binaryPayload, processorOut.toByteArray())
    }

    @Test
    fun liveSharedFirebaseAppAttachesAppCheckTokensToStorageWsOpsAndHttpByteRoute(
        @TempDir tempDir: Path
    ): Unit = runBlocking {
        val (app, _, storage) = createAuthenticatedStorage(
            appName = "live-pr3-appcheck",
            email = "pr3-appcheck@example.com",
            installDebugAppCheck = true
        )
        val appCheck = FirebaseAppCheck.getInstance(app)
        val debugToken = appCheck.getAppCheckToken(false).await().token
        assertTrue(debugToken.split('.').size == 3, "Expected 3-part App Check JWT")

        val payload = ByteArray(300 * 1024) { idx -> ((idx * 37 + 11) and 0xFF).toByte() }
        val inFile = tempDir.resolve("appcheck-live-300k.bin").toFile().apply { writeBytes(payload) }
        val outFile = tempDir.resolve("appcheck-live-300k-out.bin").toFile()

        val ref = storage.getReference("pr3-appcheck/verified-300k.bin")
        ref.putFile(
            inFile.toURI(),
            storageMetadata {
                contentType = "application/octet-stream"
                setCustomMetadata("appCheckProvider", "debug")
            }
        ).await()

        val meta = ref.getMetadata().await()
        assertEquals("debug", meta.getCustomMetadata("appCheckProvider"))
        assertArrayEquals(payload, ref.getBytes(512L * 1024L).await())

        // Switch provider to PlayIntegrityAppCheckProviderFactory and verify ranged download + list + delete
        appCheck.installAppCheckProviderFactory(PlayIntegrityAppCheckProviderFactory.getInstance(), false)
        val playToken = appCheck.getAppCheckToken(false).await().token
        assertTrue(playToken != debugToken)

        ref.getFile(outFile).await()
        assertArrayEquals(payload, outFile.readBytes())

        val dlUri = ref.getDownloadUrl().await()
        assertNotNull(dlUri)
        val listed = storage.getReference("pr3-appcheck").listAll().await()
        assertEquals(listOf("verified-300k.bin"), listed.items.map { it.name })

        ref.delete().await()
    }

    @Test
    fun liveRootReferenceOperationsAndMismatchedBucketUrlsRejectCleanly(
        @TempDir tempDir: Path
    ): Unit = runBlocking {
        val (_, _, storage) = createAuthenticatedStorage("live-pr3-root", "pr3-root@example.com")
        val root = storage.reference

        assertThrows<IllegalArgumentException> { root.getBytes(64L) }
        assertThrows<IllegalArgumentException> { root.getMetadata() }
        assertThrows<IllegalArgumentException> { root.updateMetadata(StorageMetadata.Builder().build()) }
        assertThrows<IllegalArgumentException> { root.getDownloadUrl() }
        assertThrows<IllegalArgumentException> { root.delete() }

        val rootPutEx = assertThrows<StorageException> { root.putBytes(byteArrayOf(1)).await() }
        assertEquals(StorageException.ERROR_UNKNOWN, rootPutEx.errorCode)

        val rootFileEx = assertThrows<StorageException> {
            root.getFile(tempDir.resolve("root-out.bin").toFile()).await()
        }
        assertEquals(StorageException.ERROR_UNKNOWN, rootFileEx.errorCode)

        val rootStreamEx = assertThrows<StorageException> { root.getStream().await() }
        assertEquals(StorageException.ERROR_UNKNOWN, rootStreamEx.errorCode)

        assertThrows<IllegalArgumentException> {
            storage.getReferenceFromUrl("gs://$customBucket/some/object.bin")
        }

        // listAll() IS valid on the bucket root in upstream Firebase Storage
        storage.getReference("pr3-root-list/item.bin").putBytes(byteArrayOf(42)).await()
        val rootList = root.listAll().await()
        assertTrue(rootList.prefixes.any { it.name == "pr3-root-list" })
    }
}

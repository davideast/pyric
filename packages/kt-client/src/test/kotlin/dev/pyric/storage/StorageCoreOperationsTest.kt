package dev.pyric.storage

import com.google.android.gms.tasks.Tasks
import com.google.android.gms.tasks.await
import com.google.firebase.FirebaseApp
import com.google.firebase.FirebaseOptions
import com.google.firebase.appcheck.FirebaseAppCheck
import com.google.firebase.appcheck.debug.DebugAppCheckProviderFactory
import com.google.firebase.auth.FirebaseAuth
import com.google.firebase.storage.FirebaseStorage
import com.google.firebase.storage.StorageException
import com.google.firebase.storage.StorageMetadata
import com.google.firebase.storage.component1
import com.google.firebase.storage.component2
import com.google.firebase.storage.component3
import com.google.firebase.storage.component4
import com.google.firebase.storage.storageMetadata
import kotlinx.coroutines.runBlocking
import org.junit.jupiter.api.AfterEach
import org.junit.jupiter.api.Assertions.assertArrayEquals
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.BeforeEach
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.assertThrows
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.ExecutionException

class StorageCoreOperationsTest {

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
            .setProjectId("ops-proj")
            .setApiKey("ops-key")
            .setApplicationId("1:123456:android:ops")
            .setStorageBucket("ops-proj.appspot.com")
            .build()
        app = FirebaseApp.initializeApp("ops-app", options)
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
    fun putBytesAndGetBytesRoundTripBinaryDataMetadataAndProgress() = runBlocking {
        val ref = storage.getReference("media/clip.bin")
        val payload = ByteArray(1024) { idx -> ((idx * 37 + 13) and 0xFF).toByte() }
        val uploadMeta = storageMetadata {
            contentType = "application/x-custom-bin"
            cacheControl = "private, max-age=120"
            setCustomMetadata("shaTag", "v1")
        }

        val observedProgress = CopyOnWriteArrayList<Long>()
        val uploadTask = ref.putBytes(payload, uploadMeta)
        uploadTask.addOnProgressListener { snap ->
            observedProgress.add(snap.bytesTransferred)
        }

        val snapshot = uploadTask.await()
        val (transferred, total, storedMeta, sessionUri) = snapshot
        assertEquals(1024L, transferred)
        assertEquals(1024L, total)
        assertNull(sessionUri)
        assertEquals("application/x-custom-bin", storedMeta?.contentType)
        assertEquals("private, max-age=120", storedMeta?.cacheControl)
        assertEquals("v1", storedMeta?.getCustomMetadata("shaTag"))
        assertEquals(1024L, storedMeta?.sizeBytes)
        assertEquals("media/clip.bin", storedMeta?.path)
        assertEquals("clip.bin", storedMeta?.name)
        assertTrue(observedProgress.contains(1024L))

        val downloaded = ref.getBytes(4096L).await()
        assertArrayEquals(payload, downloaded)
    }

    @Test
    fun getBytesEnforcesPositiveLimitAndBufferOverflowAndChunkedFallback() = runBlocking {
        val ref = storage.getReference("blobs/sized.bin")
        val payload = ByteArray(512) { (it and 0xFF).toByte() }
        ref.putBytes(payload).await()

        assertThrows<IllegalArgumentException> {
            ref.getBytes(0L)
        }
        assertThrows<IllegalArgumentException> {
            ref.getBytes(-10L)
        }

        val overflowEx = assertThrows<StorageException> {
            ref.getBytes(256L).await()
        }
        assertEquals(StorageException.ERROR_UNKNOWN, overflowEx.errorCode)
        assertTrue(overflowEx.cause is IndexOutOfBoundsException)
        assertTrue(overflowEx.message!!.contains("maximum allowed buffer size was exceeded"))

        // Verify range-chunked fallback when single-frame getBytes returns payload-too-large.
        harness.forceSingleShotPayloadTooLargeAboveBytes = 128
        val reassembled = ref.getBytes(1024L).await()
        assertArrayEquals(payload, reassembled)
        val rangeGetCount = harness.recordedOps.count {
            it["method"] == "storage.getBytes" && it["offset"] != null
        }
        assertTrue(rangeGetCount >= 1)
    }

    @Test
    fun getMetadataUpdateMetadataDownloadUrlAndDeleteLifecycle() = runBlocking {
        val ref = storage.getReference("docs/quarterly report.txt")
        val initialBytes = "Q4 revenue summary".toByteArray(Charsets.UTF_8)
        ref.putBytes(
            initialBytes,
            storageMetadata {
                contentType = "text/plain"
                cacheControl = "max-age=60"
                setCustomMetadata("team", "finance")
                setCustomMetadata("tempFlag", "draft")
            }
        ).await()

        val initialMeta = ref.getMetadata().await()
        assertEquals("text/plain", initialMeta.contentType)
        assertEquals("max-age=60", initialMeta.cacheControl)
        assertEquals("finance", initialMeta.getCustomMetadata("team"))
        assertEquals("draft", initialMeta.getCustomMetadata("tempFlag"))
        assertEquals("1", initialMeta.metadataGeneration)

        // Direct storage.setMetadata patch path
        val updatedMeta = ref.updateMetadata(
            StorageMetadata.Builder()
                .setCacheControl(null)
                .setContentLanguage("en-US")
                .setCustomMetadata("tempFlag", null)
                .setCustomMetadata("status", "approved")
                .build()
        ).await()

        assertNull(updatedMeta.cacheControl)
        assertEquals("en-US", updatedMeta.contentLanguage)
        assertEquals("finance", updatedMeta.getCustomMetadata("team"))
        assertNull(updatedMeta.getCustomMetadata("tempFlag"))
        assertEquals("approved", updatedMeta.getCustomMetadata("status"))
        assertEquals("2", updatedMeta.metadataGeneration)

        // Admin-gated storage.setMetadata fallback path (matching unmodified HostedRuntime)
        harness.restrictSetMetadataToAdmin = true
        val fallbackUpdated = ref.updateMetadata(
            StorageMetadata.Builder()
                .setCustomMetadata("status", "final")
                .setCustomMetadata("team", null)
                .build()
        ).await()
        assertEquals("final", fallbackUpdated.getCustomMetadata("status"))
        assertNull(fallbackUpdated.getCustomMetadata("team"))
        assertEquals(setOf("status"), fallbackUpdated.customMetadataKeys)
        assertArrayEquals(initialBytes, ref.getBytes(1024L).await())

        // Download URL resolution
        val downloadUri = ref.getDownloadUrl().await()
        assertEquals("http", downloadUri.scheme)
        assertTrue(downloadUri.toString().contains("/__pyric/storage/v0/b/ops-proj.appspot.com/o/"))
        assertTrue(downloadUri.toString().contains("token="))
        assertEquals(ref, storage.getReferenceFromUrl(downloadUri.toString()))

        // Delete removes object; subsequent reads fail with ERROR_OBJECT_NOT_FOUND
        ref.delete().await()

        val afterDeleteMetaEx = assertThrows<StorageException> {
            ref.getMetadata().await()
        }
        assertEquals(StorageException.ERROR_OBJECT_NOT_FOUND, afterDeleteMetaEx.errorCode)

        val secondDeleteEx = assertThrows<StorageException> {
            ref.delete().await()
        }
        assertEquals(StorageException.ERROR_OBJECT_NOT_FOUND, secondDeleteEx.errorCode)
    }

    @Test
    fun listAllAndPaginatedListFollowGcsDelimiterSortOrder() = runBlocking {
        // Upload items and nested folders whose names test '-' (0x2D) < '.' (0x2E) < '/' (0x2F).
        val paths = listOf(
            "catalog/a-folder/nested.txt",
            "catalog/a.txt",
            "catalog/a/inside.txt",
            "catalog/b.txt",
            "catalog/c-dir/deep/leaf.txt"
        )
        for (p in paths) {
            storage.getReference(p).putBytes("x".toByteArray()).await()
        }

        val catalogRef = storage.getReference("catalog")
        val all = catalogRef.listAll().await()
        val (allItems, allPrefixes, allToken) = all
        assertNull(allToken)
        assertEquals(listOf("/catalog/a.txt", "/catalog/b.txt"), allItems.map { it.path })
        assertEquals(
            listOf("/catalog/a-folder", "/catalog/a", "/catalog/c-dir"),
            allPrefixes.map { it.path }
        )

        assertThrows<IllegalArgumentException> { catalogRef.list(0) }
        assertThrows<IllegalArgumentException> { catalogRef.list(1001) }
        assertThrows<IllegalArgumentException> { catalogRef.list(2, "") }

        // Unified GCS delimiter order across the 5 entries:
        // 1. prefix "catalog/a-folder/" ('-' = 45)
        // 2. item   "catalog/a.txt"     ('.' = 46)
        // 3. prefix "catalog/a/"        ('/' = 47)
        // 4. item   "catalog/b.txt"
        // 5. prefix "catalog/c-dir/"
        val page1 = catalogRef.list(2).await()
        assertEquals(listOf("/catalog/a-folder"), page1.prefixes.map { it.path })
        assertEquals(listOf("/catalog/a.txt"), page1.items.map { it.path })
        assertTrue(!page1.pageToken.isNullOrEmpty())

        val page2 = catalogRef.list(2, page1.pageToken!!).await()
        assertEquals(listOf("/catalog/a"), page2.prefixes.map { it.path })
        assertEquals(listOf("/catalog/b.txt"), page2.items.map { it.path })
        assertTrue(!page2.pageToken.isNullOrEmpty())

        val page3 = catalogRef.list(2, page2.pageToken!!).await()
        assertEquals(listOf("/catalog/c-dir"), page3.prefixes.map { it.path })
        assertTrue(page3.items.isEmpty())
        assertNull(page3.pageToken)
    }

    @Test
    fun rootReferencePreconditionsAuthLensAndCustomBucketWireParams() = runBlocking {
        val root = storage.reference
        assertThrows<IllegalArgumentException> { root.getMetadata() }
        assertThrows<IllegalArgumentException> { root.getDownloadUrl() }
        assertThrows<IllegalArgumentException> { root.getBytes(1024L) }
        assertThrows<IllegalArgumentException> { root.delete() }
        assertThrows<IllegalArgumentException> {
            root.updateMetadata(StorageMetadata.Builder().setContentType("text/plain").build())
        }

        // Root putBytes fails asynchronously on the returned UploadTask
        val rootUploadEx = assertThrows<ExecutionException> {
            Tasks.await(root.putBytes(byteArrayOf(1, 2, 3)))
        }.cause as StorageException
        assertEquals(StorageException.ERROR_UNKNOWN, rootUploadEx.errorCode)
        assertTrue(rootUploadEx.cause is IllegalArgumentException)

        // Require Auth and verify unauthenticated denial -> sign-in success -> custom bucket wire routing
        harness.requireAuthenticated = true
        val customStorage = FirebaseStorage.getInstance(app, harness.transport.let { storage.bridgeClient }, "gs://custom-vault")
        val secretRef = customStorage.getReference("secrets/key.bin")

        val deniedEx = assertThrows<StorageException> {
            secretRef.putBytes(byteArrayOf(7, 8, 9)).await()
        }
        assertEquals(StorageException.ERROR_NOT_AUTHORIZED, deniedEx.errorCode)

        val auth = FirebaseAuth.getInstance(app, storage.bridgeClient)
        auth.createUserWithEmailAndPassword("alice@example.com", "SafePass!123").await()

        // Install App Check debug provider on a mock handler? Verify wire bucket + actAs first.
        harness.recordedOps.clear()
        secretRef.putBytes(byteArrayOf(7, 8, 9)).await()
        val putOp = harness.recordedOps.first { it["method"] == "storage.putBytes" }
        assertEquals("custom-vault", putOp["bucket"])
        assertEquals("ops-proj.appspot.com", putOp["defaultBucket"])
        assertEquals("secrets/key.bin", putOp["path"])
        @Suppress("UNCHECKED_CAST")
        val actAs = putOp["actAs"] as Map<String, Any?>
        assertEquals("as", actAs["mode"])
        assertEquals("uid-alice", actAs["uid"])

        auth.signOut()
        val deniedAfterSignOut = assertThrows<StorageException> {
            secretRef.getBytes(64L).await()
        }
        assertEquals(StorageException.ERROR_NOT_AUTHORIZED, deniedAfterSignOut.errorCode)
    }
}

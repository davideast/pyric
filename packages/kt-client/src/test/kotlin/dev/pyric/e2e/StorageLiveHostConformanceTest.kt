package dev.pyric.e2e

import com.google.android.gms.tasks.await
import com.google.firebase.Firebase
import com.google.firebase.FirebaseApp
import com.google.firebase.FirebaseOptions
import com.google.firebase.auth.FirebaseAuth
import com.google.firebase.storage.FirebaseStorage
import com.google.firebase.storage.StorageException
import com.google.firebase.storage.StorageMetadata
import com.google.firebase.storage.component1
import com.google.firebase.storage.component2
import com.google.firebase.storage.component3
import com.google.firebase.storage.storage
import com.google.firebase.storage.storageMetadata
import dev.pyric.bridge.PyricBridgeClient
import kotlinx.coroutines.runBlocking
import okhttp3.OkHttpClient
import okhttp3.Request
import org.junit.jupiter.api.AfterEach
import org.junit.jupiter.api.Assertions.assertArrayEquals
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Assertions.assertSame
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Assumptions
import org.junit.jupiter.api.BeforeEach
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.assertThrows

class StorageLiveHostConformanceTest {

    private lateinit var liveBridgeUrl: String
    private lateinit var projectId: String
    private lateinit var defaultBucket: String
    private lateinit var customBucket: String
    private val bridges = mutableListOf<PyricBridgeClient>()
    private val plainHttp = OkHttpClient()

    @BeforeEach
    fun setUp() {
        val envUrl = System.getenv("PYRIC_LIVE_STORAGE_BRIDGE_URL")
        Assumptions.assumeTrue(
            !envUrl.isNullOrBlank(),
            "Skipping StorageLiveHostConformanceTest: PYRIC_LIVE_STORAGE_BRIDGE_URL is unset"
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

    private fun createAppAndStorage(appName: String): Triple<FirebaseApp, FirebaseAuth, FirebaseStorage> {
        val options = FirebaseOptions.Builder()
            .setProjectId(projectId)
            .setApiKey("sandbox-api-key")
            .setApplicationId("1:424242424242:android:kotlinstorage")
            .setStorageBucket(defaultBucket)
            .build()
        val app = FirebaseApp.initializeApp(appName, options)
        val bridge = PyricBridgeClient(url = liveBridgeUrl)
        bridges.add(bridge)
        val auth = FirebaseAuth.getInstance(app, bridge)
        val storage = FirebaseStorage.getInstance(app, bridge)
        return Triple(app, auth, storage)
    }

    @Test
    fun deniesUnauthenticatedOperationsUnderStorageSecurityRules() = runBlocking {
        val (app, _, storage) = createAppAndStorage("live-storage-unauth")
        assertSame(storage, Firebase.storage(app))

        val targetRef = storage.getReference("private/unauth-probe.txt")

        val putEx = assertThrows<StorageException> {
            targetRef.putBytes("forbidden".toByteArray(Charsets.UTF_8)).await()
        }
        assertEquals(StorageException.ERROR_NOT_AUTHORIZED, putEx.errorCode)

        val getEx = assertThrows<StorageException> {
            targetRef.getBytes(1024L).await()
        }
        assertEquals(StorageException.ERROR_NOT_AUTHORIZED, getEx.errorCode)

        val metaEx = assertThrows<StorageException> {
            targetRef.getMetadata().await()
        }
        assertEquals(StorageException.ERROR_NOT_AUTHORIZED, metaEx.errorCode)

        val updateEx = assertThrows<StorageException> {
            targetRef.updateMetadata(storageMetadata { contentType = "text/plain" }).await()
        }
        assertEquals(StorageException.ERROR_NOT_AUTHORIZED, updateEx.errorCode)

        val urlEx = assertThrows<StorageException> {
            targetRef.getDownloadUrl().await()
        }
        assertEquals(StorageException.ERROR_NOT_AUTHORIZED, urlEx.errorCode)

        val deleteEx = assertThrows<StorageException> {
            targetRef.delete().await()
        }
        assertEquals(StorageException.ERROR_NOT_AUTHORIZED, deleteEx.errorCode)

        val listEx = assertThrows<StorageException> {
            storage.getReference("private").listAll().await()
        }
        assertEquals(StorageException.ERROR_NOT_AUTHORIZED, listEx.errorCode)
    }

    @Test
    fun authenticatedUploadDownloadMetadataUpdateAndSignOutRevocation() = runBlocking {
        val (_, auth, storage) = createAppAndStorage("live-storage-crud")
        auth.createUserWithEmailAndPassword("storage-crud@example.com", "StrongPass!123").await()

        val payload = ByteArray(4096) { i -> ((i * 73 + 19) and 0xFF).toByte() }
        val ref = storage.getReference("users/crud/avatar_v1.bin")
        val initialMetadata = storageMetadata {
            contentType = "application/octet-stream"
            cacheControl = "public, max-age=180"
            contentLanguage = "en"
            setCustomMetadata("owner", "storage-crud")
            setCustomMetadata("ephemeral", "remove-me")
        }

        val uploadSnap = ref.putBytes(payload, initialMetadata).await()
        assertEquals(payload.size.toLong(), uploadSnap.bytesTransferred)
        assertEquals(payload.size.toLong(), uploadSnap.totalByteCount)
        assertEquals(defaultBucket, uploadSnap.metadata?.bucket)
        assertEquals("users/crud/avatar_v1.bin", uploadSnap.metadata?.path)
        assertEquals("avatar_v1.bin", uploadSnap.metadata?.name)
        assertTrue((uploadSnap.metadata?.md5Hash ?: "").isNotBlank())
        assertTrue((uploadSnap.metadata?.creationTimeMillis ?: 0L) > 0L)

        val fetchedBytes = ref.getBytes(8192L).await()
        assertArrayEquals(payload, fetchedBytes)

        // Overflow protection when maxDownloadSizeBytes < object size
        val overflowEx = assertThrows<StorageException> {
            ref.getBytes(1024L).await()
        }
        assertEquals(StorageException.ERROR_UNKNOWN, overflowEx.errorCode)
        assertTrue(overflowEx.cause is IndexOutOfBoundsException)

        val patchedMeta = ref.updateMetadata(
            StorageMetadata.Builder()
                .setContentType("application/x-pyric-avatar")
                .setCacheControl(null)
                .setCustomMetadata("ephemeral", null)
                .setCustomMetadata("version", "2")
                .build()
        ).await()

        assertEquals("application/x-pyric-avatar", patchedMeta.contentType)
        assertNull(patchedMeta.cacheControl)
        assertEquals("storage-crud", patchedMeta.getCustomMetadata("owner"))
        assertNull(patchedMeta.getCustomMetadata("ephemeral"))
        assertEquals("2", patchedMeta.getCustomMetadata("version"))

        val rereadMeta = ref.getMetadata().await()
        assertEquals("application/x-pyric-avatar", rereadMeta.contentType)
        assertNull(rereadMeta.cacheControl)
        assertEquals(setOf("owner", "version"), rereadMeta.customMetadataKeys)
        assertArrayEquals(payload, ref.getBytes(8192L).await())

        // Signing out immediately revokes Storage access on the shared FirebaseApp
        auth.signOut()
        val postSignOutEx = assertThrows<StorageException> {
            ref.getMetadata().await()
        }
        assertEquals(StorageException.ERROR_NOT_AUTHORIZED, postSignOutEx.errorCode)
    }

    @Test
    fun getDownloadUrlMintsTokenizedHttpUrlAndRoundTripsGetReferenceFromUrl() = runBlocking {
        val (_, auth, storage) = createAppAndStorage("live-storage-url")
        auth.createUserWithEmailAndPassword("storage-url@example.com", "StrongPass!123").await()

        val messageBytes = "Hello from live Pyric Kotlin Storage download URL!".toByteArray(Charsets.UTF_8)
        val ref = storage.getReference("shared/greetings/hello world.txt")
        ref.putBytes(
            messageBytes,
            storageMetadata { contentType = "text/plain; charset=utf-8" }
        ).await()

        val downloadUri = ref.getDownloadUrl().await()
        assertEquals("http", downloadUri.scheme)
        assertTrue(downloadUri.toString().contains("token="))

        // Fetch directly over plain HTTP without SDK headers: the minted token grants access.
        plainHttp.newCall(Request.Builder().url(downloadUri.toString()).get().build()).execute().use { resp ->
            assertEquals(200, resp.code)
            val bodyBytes = resp.body?.bytes() ?: ByteArray(0)
            assertArrayEquals(messageBytes, bodyBytes)
        }

        val resolvedRef = storage.getReferenceFromUrl(downloadUri.toString())
        assertEquals(ref, resolvedRef)
        assertEquals("/shared/greetings/hello world.txt", resolvedRef.path)
        assertEquals("hello world.txt", resolvedRef.name)
    }

    @Test
    fun listAllPaginatedListAndDeleteAcrossHierarchy() = runBlocking {
        val (_, auth, storage) = createAppAndStorage("live-storage-list")
        auth.createUserWithEmailAndPassword("storage-list@example.com", "StrongPass!123").await()

        val basePrefix = "tree-${System.nanoTime()}"
        val objectPaths = listOf(
            "$basePrefix/alpha-dir/one.txt",
            "$basePrefix/alpha.txt",
            "$basePrefix/alpha/two.txt",
            "$basePrefix/beta.txt",
            "$basePrefix/gamma-dir/three.txt"
        )
        for (path in objectPaths) {
            storage.getReference(path).putBytes(path.toByteArray(Charsets.UTF_8)).await()
        }

        val folderRef = storage.getReference(basePrefix)
        val (allItems, allPrefixes, allPageToken) = folderRef.listAll().await()
        assertNull(allPageToken)
        assertEquals(
            listOf("/$basePrefix/alpha.txt", "/$basePrefix/beta.txt"),
            allItems.map { it.path }
        )
        assertEquals(
            listOf("/$basePrefix/alpha-dir", "/$basePrefix/alpha", "/$basePrefix/gamma-dir"),
            allPrefixes.map { it.path }
        )

        // Paginate 2 at a time through all 5 entries
        val p1 = folderRef.list(2).await()
        assertEquals(1, p1.prefixes.size)
        assertEquals(1, p1.items.size)
        assertEquals("/$basePrefix/alpha-dir", p1.prefixes[0].path)
        assertEquals("/$basePrefix/alpha.txt", p1.items[0].path)

        val p2 = folderRef.list(2, p1.pageToken!!).await()
        assertEquals(listOf("/$basePrefix/alpha"), p2.prefixes.map { it.path })
        assertEquals(listOf("/$basePrefix/beta.txt"), p2.items.map { it.path })

        val p3 = folderRef.list(2, p2.pageToken!!).await()
        assertEquals(listOf("/$basePrefix/gamma-dir"), p3.prefixes.map { it.path })
        assertTrue(p3.items.isEmpty())
        assertNull(p3.pageToken)

        // Delete alpha.txt and verify it disappears from listAll and throws ERROR_OBJECT_NOT_FOUND
        val alphaFileRef = storage.getReference("$basePrefix/alpha.txt")
        alphaFileRef.delete().await()

        val notFoundEx = assertThrows<StorageException> {
            alphaFileRef.getBytes(1024L).await()
        }
        assertEquals(StorageException.ERROR_OBJECT_NOT_FOUND, notFoundEx.errorCode)

        val afterDeleteList = folderRef.listAll().await()
        assertEquals(listOf("/$basePrefix/beta.txt"), afterDeleteList.items.map { it.path })
    }

    @Test
    fun customGsBucketIsolatesObjectsAndEnforcesBucketScopedRules() = runBlocking {
        val (app, auth, defaultStorage) = createAppAndStorage("live-storage-buckets")
        val customStorage = FirebaseStorage.getInstance(
            app,
            defaultStorage.bridgeClient,
            "gs://$customBucket"
        )
        assertSame(customStorage, Firebase.storage(app, "gs://$customBucket/"))

        val sharedPath = "isolated/item.txt"
        val defaultRef = defaultStorage.getReference(sharedPath)
        val customRef = customStorage.getReference(sharedPath)

        // Unauthenticated custom bucket write must also be denied by custom bucket rules
        val deniedCustom = assertThrows<StorageException> {
            customRef.putBytes("nope".toByteArray(Charsets.UTF_8)).await()
        }
        assertEquals(StorageException.ERROR_NOT_AUTHORIZED, deniedCustom.errorCode)

        auth.createUserWithEmailAndPassword("bucket-owner@example.com", "StrongPass!123").await()

        val defaultBytes = "default-bucket-payload".toByteArray(Charsets.UTF_8)
        val customBytes = "custom-bucket-payload".toByteArray(Charsets.UTF_8)

        val defaultSnap = defaultRef.putBytes(defaultBytes).await()
        val customSnap = customRef.putBytes(customBytes).await()

        assertEquals(defaultBucket, defaultSnap.metadata?.bucket)
        assertEquals(customBucket, customSnap.metadata?.bucket)

        assertArrayEquals(defaultBytes, defaultRef.getBytes(1024L).await())
        assertArrayEquals(customBytes, customRef.getBytes(1024L).await())

        customRef.delete().await()
        // Deleting from custom bucket leaves default bucket intact
        assertArrayEquals(defaultBytes, defaultRef.getBytes(1024L).await())
        val customGone = assertThrows<StorageException> {
            customRef.getMetadata().await()
        }
        assertEquals(StorageException.ERROR_OBJECT_NOT_FOUND, customGone.errorCode)
    }

    @Test
    fun zeroByteObjectAndClonedMetadataRoundTripOverHttpByteRoute() = runBlocking {
        val (_, auth, storage) = createAppAndStorage("live-storage-zero-byte")
        auth.createUserWithEmailAndPassword("zero-byte@example.com", "StrongPass!123").await()

        val emptyRef = storage.getReference("markers/.keep")
        val uploadSnap = emptyRef.putBytes(
            ByteArray(0),
            storageMetadata {
                contentType = "application/x-empty"
                setCustomMetadata("keepKey", "present")
                setCustomMetadata("removeKey", "temporary")
            }
        ).await()

        assertEquals(0L, uploadSnap.totalByteCount)
        assertEquals(0L, uploadSnap.bytesTransferred)
        assertEquals(0L, uploadSnap.metadata?.sizeBytes)

        val fetchedEmpty = emptyRef.getBytes(64L).await()
        assertArrayEquals(ByteArray(0), fetchedEmpty)

        val clonedUpdate = StorageMetadata.Builder(uploadSnap.metadata!!)
            .setCustomMetadata("removeKey", null)
            .setCustomMetadata("addedKey", "confirmed")
            .build()
        val updatedMeta = emptyRef.updateMetadata(clonedUpdate).await()
        assertEquals("application/x-empty", updatedMeta.contentType)
        assertEquals("present", updatedMeta.getCustomMetadata("keepKey"))
        assertNull(updatedMeta.getCustomMetadata("removeKey"))
        assertEquals("confirmed", updatedMeta.getCustomMetadata("addedKey"))
        assertArrayEquals(ByteArray(0), emptyRef.getBytes(64L).await())
    }
}

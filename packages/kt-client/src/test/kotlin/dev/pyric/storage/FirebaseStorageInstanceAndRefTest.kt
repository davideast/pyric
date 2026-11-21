package dev.pyric.storage

import com.google.firebase.Firebase
import com.google.firebase.FirebaseApp
import com.google.firebase.FirebaseOptions
import com.google.firebase.auth.FirebaseAuth
import com.google.firebase.storage.FirebaseStorage
import com.google.firebase.storage.StorageReference
import com.google.firebase.storage.storage
import org.junit.jupiter.api.AfterEach
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertNotEquals
import org.junit.jupiter.api.Assertions.assertNotSame
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Assertions.assertSame
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.BeforeEach
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.assertThrows
import java.lang.reflect.Modifier

class FirebaseStorageInstanceAndRefTest {
    private val harnesses = mutableListOf<StorageMockBridgeHarness>()
    private fun newHarness(): StorageMockBridgeHarness = StorageMockBridgeHarness().also { harnesses.add(it) }

    @BeforeEach
    fun setUp() {
        FirebaseStorage.clearInstancesForTest()
        FirebaseAuth.clearInstancesForTest()
        FirebaseApp.clearInstancesForTest()
    }

    @AfterEach
    fun tearDown() {
        harnesses.forEach { it.closeAll() }
        harnesses.clear()
        FirebaseStorage.clearInstancesForTest()
        FirebaseAuth.clearInstancesForTest()
        FirebaseApp.clearInstancesForTest()
    }

    @Test
    fun singletonAndCustomBucketFactoriesNormalizeAndCachePerAppAndBucket() {
        val options = FirebaseOptions.Builder()
            .setProjectId("demo-storage")
            .setApiKey("demo-key")
            .setApplicationId("1:123:android:abc")
            .setStorageBucket("demo-storage.appspot.com")
            .build()
        val app = FirebaseApp.initializeApp(options)
        val harness = newHarness()
        val defaultStorage = FirebaseStorage.getInstance(app, harness.newBridgeClient())

        assertSame(defaultStorage, FirebaseStorage.getInstance())
        assertSame(defaultStorage, FirebaseStorage.getInstance(app))
        assertSame(defaultStorage, FirebaseStorage.getInstance("gs://demo-storage.appspot.com"))
        assertSame(defaultStorage, FirebaseStorage.getInstance("gs://demo-storage.appspot.com/"))
        assertSame(defaultStorage, FirebaseStorage.getInstance(app, "gs://DEMO-STORAGE.APPSPOT.COM/"))
        assertSame(defaultStorage, Firebase.storage)
        assertSame(defaultStorage, Firebase.storage(app))
        assertSame(defaultStorage, Firebase.storage("gs://demo-storage.appspot.com"))
        assertSame(defaultStorage, Firebase.storage(app, "gs://demo-storage.appspot.com/"))

        val archiveStorage = FirebaseStorage.getInstance(app, "gs://archive-bucket.firebasestorage.app/")
        assertNotSame(defaultStorage, archiveStorage)
        assertSame(archiveStorage, FirebaseStorage.getInstance("gs://archive-bucket.firebasestorage.app"))
        assertEquals("gs://archive-bucket.firebasestorage.app/", archiveStorage.reference.toString())

        val secondaryOptions = FirebaseOptions.Builder()
            .setProjectId("secondary-proj")
            .setApiKey("sec-key")
            .setApplicationId("1:999:android:xyz")
            .setStorageBucket("gs://secondary-proj.appspot.com/")
            .build()
        val secondaryApp = FirebaseApp.initializeApp(Any(), secondaryOptions, "secondary")
        val secondaryHarness = newHarness()
        val secondaryStorage = FirebaseStorage.getInstance(secondaryApp, secondaryHarness.newBridgeClient())

        assertNotSame(defaultStorage, secondaryStorage)
        assertSame(secondaryApp, secondaryStorage.app)
        assertEquals("secondary-proj.appspot.com", secondaryStorage.reference.bucket)
    }

    @Test
    fun reinitializingSameNamedFirebaseAppProducesFreshStorageInstance() {
        val opts1 = FirebaseOptions.Builder()
            .setProjectId("proj-one")
            .setApiKey("k1")
            .setApplicationId("a1")
            .setStorageBucket("bucket-one.appspot.com")
            .build()
        val app1 = FirebaseApp.initializeApp("reinit-app", opts1)
        val storage1 = FirebaseStorage.getInstance(app1, newHarness().newBridgeClient())
        assertEquals("bucket-one.appspot.com", storage1.reference.bucket)

        val opts2 = FirebaseOptions.Builder()
            .setProjectId("proj-two")
            .setApiKey("k2")
            .setApplicationId("a2")
            .setStorageBucket("bucket-two.appspot.com")
            .build()
        val app2 = FirebaseApp.initializeApp("reinit-app", opts2)
        val storage2 = FirebaseStorage.getInstance(app2, newHarness().newBridgeClient())

        assertNotSame(storage1, storage2)
        assertSame(app2, storage2.app)
        assertEquals("bucket-two.appspot.com", storage2.reference.bucket)
    }

    @Test
    fun getInstanceValidatesGsSchemeAndRejectsObjectPaths() {
        val harness = newHarness()
        FirebaseStorage.getInstance(FirebaseApp.getInstance(), harness.newBridgeClient())

        val httpEx = assertThrows<IllegalArgumentException> {
            FirebaseStorage.getInstance("https://demo.appspot.com/")
        }
        assertEquals("Please use a gs:// URL for your Firebase Storage bucket.", httpEx.message)

        val bareEx = assertThrows<IllegalArgumentException> {
            FirebaseStorage.getInstance("demo.appspot.com")
        }
        assertEquals("Please use a gs:// URL for your Firebase Storage bucket.", bareEx.message)

        val pathEx = assertThrows<IllegalArgumentException> {
            FirebaseStorage.getInstance("gs://demo.appspot.com/nested/file.txt")
        }
        assertEquals("The storage Uri cannot contain a path element.", pathEx.message)

        val emptyBucketOptions = FirebaseOptions.Builder()
            .setProjectId("")
            .setApiKey("k")
            .setApplicationId("a")
            .setStorageBucket("")
            .build()
        val emptyApp = FirebaseApp.initializeApp("empty-bucket-app", emptyBucketOptions)
        val unconfiguredStorage = FirebaseStorage.getInstance(emptyApp, harness.newBridgeClient())
        assertThrows<IllegalStateException> {
            unconfiguredStorage.reference
        }
    }

    @Test
    fun retryTimeoutsAndUseEmulatorRetainSettingsAndValidateArguments() {
        val storage = FirebaseStorage.getInstance(
            FirebaseApp.getInstance(),
            newHarness().newBridgeClient()
        )

        assertEquals(600_000L, storage.maxUploadRetryTimeMillis)
        assertEquals(600_000L, storage.maxDownloadRetryTimeMillis)
        assertEquals(120_000L, storage.maxOperationRetryTimeMillis)

        storage.maxUploadRetryTimeMillis = 45_000L
        storage.maxDownloadRetryTimeMillis = 30_000L
        storage.maxOperationRetryTimeMillis = 15_000L

        assertEquals(45_000L, storage.reference.storage.maxUploadRetryTimeMillis)
        assertEquals(30_000L, storage.reference.storage.maxDownloadRetryTimeMillis)
        assertEquals(15_000L, storage.reference.storage.maxOperationRetryTimeMillis)

        storage.useEmulator("10.0.2.2", 9199)
        assertEquals("10.0.2.2", storage.emulatorHost)
        assertEquals(9199, storage.emulatorPort)

        assertThrows<IllegalArgumentException> { storage.useEmulator("", 9199) }
        assertThrows<IllegalArgumentException> { storage.useEmulator("127.0.0.1", 0) }
        assertThrows<IllegalArgumentException> { storage.useEmulator("127.0.0.1", 70_000) }
    }

    @Test
    fun storageReferenceNavigationHierarchyAndEqualityMatchUpstreamContract() {
        val options = FirebaseOptions.Builder()
            .setProjectId("nav-proj")
            .setApiKey("k")
            .setApplicationId("a")
            .setStorageBucket("nav-proj.appspot.com")
            .build()
        val app = FirebaseApp.initializeApp("nav-app", options)
        val storage = FirebaseStorage.getInstance(app, newHarness().newBridgeClient())

        val root = storage.reference
        assertEquals("/", root.path)
        assertEquals("", root.name)
        assertEquals("nav-proj.appspot.com", root.bucket)
        assertNull(root.parent)
        assertEquals(root, root.root)
        assertEquals("gs://nav-proj.appspot.com/", root.toString())

        val nested = root.child("/users//u-42/avatars/profile.png/")
        assertEquals("/users/u-42/avatars/profile.png", nested.path)
        assertEquals("profile.png", nested.name)
        assertEquals("nav-proj.appspot.com", nested.bucket)
        assertSame(storage, nested.storage)
        assertEquals("gs://nav-proj.appspot.com/users/u-42/avatars/profile.png", nested.toString())

        val avatarsDir = nested.parent
        assertEquals("/users/u-42/avatars", avatarsDir?.path)
        assertEquals("avatars", avatarsDir?.name)
        assertEquals("/users/u-42", avatarsDir?.parent?.path)
        assertEquals("/users", avatarsDir?.parent?.parent?.path)
        assertEquals(root, avatarsDir?.parent?.parent?.parent)
        assertNull(avatarsDir?.parent?.parent?.parent?.parent)
        assertEquals(root, nested.root)

        val sameRef = storage.getReference("users/u-42").child("avatars/profile.png")
        assertEquals(nested, sameRef)
        assertEquals(nested.hashCode(), sameRef.hashCode())
        assertEquals(0, nested.compareTo(sameRef))

        val otherRef = storage.getReference("users/u-99/avatars/profile.png")
        assertNotEquals(nested, otherRef)
        assertTrue(nested < otherRef)

        assertThrows<IllegalArgumentException> { root.child("") }
        assertThrows<IllegalArgumentException> { storage.getReference("") }
        assertThrows<IllegalArgumentException> {
            storage.getReference("gs://nav-proj.appspot.com/users/u-42")
        }
    }

    @Test
    fun getReferenceFromUrlParsesGsFirebaseCloudAndPyricByteRouteUrls() {
        val options = FirebaseOptions.Builder()
            .setProjectId("url-proj")
            .setApiKey("k")
            .setApplicationId("a")
            .setStorageBucket("url-proj.appspot.com")
            .build()
        val app = FirebaseApp.initializeApp("url-app", options)
        val storage = FirebaseStorage.getInstance(app, newHarness().newBridgeClient())

        val fromGs = storage.getReferenceFromUrl("gs://url-proj.appspot.com/docs/my report+v1.pdf")
        val fromFirebaseDownload = storage.getReferenceFromUrl(
            "https://firebasestorage.googleapis.com/v0/b/url-proj.appspot.com/o/docs%2Fmy%20report%2Bv1.pdf?alt=media&token=abc-123"
        )
        val fromGcs = storage.getReferenceFromUrl(
            "https://storage.googleapis.com/url-proj.appspot.com/docs/my%20report%2Bv1.pdf"
        )
        val fromPyricHost = storage.reference.getReferenceFromUrl(
            "http://127.0.0.1:45123/__pyric/storage/v0/b/url-proj.appspot.com/o/docs%2Fmy%20report%2Bv1.pdf?alt=media&token=tok-1"
        )

        assertEquals("/docs/my report+v1.pdf", fromGs.path)
        assertEquals("my report+v1.pdf", fromGs.name)
        assertEquals(fromGs, fromFirebaseDownload)
        assertEquals(fromGs, fromGcs)
        assertEquals(fromGs, fromPyricHost)

        val rootFromGs = storage.getReferenceFromUrl("gs://url-proj.appspot.com/")
        assertEquals(storage.reference, rootFromGs)

        // Mismatched bucket must fail with IllegalArgumentException.
        assertThrows<IllegalArgumentException> {
            storage.getReferenceFromUrl("gs://different-bucket.appspot.com/docs/file.pdf")
        }
        assertThrows<IllegalArgumentException> {
            storage.getReferenceFromUrl("gs2://url-proj.appspot.com/docs/file.pdf")
        }
        assertThrows<IllegalArgumentException> {
            storage.getReferenceFromUrl("data:text/plain;base64,aGVsbG8=")
        }
    }

    @Test
    fun jvmBytecodeExposesStaticFactoriesAndStorageKtExtensions() {
        val storageClass = Class.forName("com.google.firebase.storage.FirebaseStorage")
        val appClass = Class.forName("com.google.firebase.FirebaseApp")
        val staticMethods = listOf(
            storageClass.getMethod("getInstance"),
            storageClass.getMethod("getInstance", String::class.java),
            storageClass.getMethod("getInstance", appClass),
            storageClass.getMethod("getInstance", appClass, String::class.java)
        )
        for (method in staticMethods) {
            assertTrue(Modifier.isStatic(method.modifiers), "Expected ${method.name} to be static")
        }

        val ktxClass = Class.forName("com.google.firebase.storage.StorageKt")
        val firebaseClass = Class.forName("com.google.firebase.Firebase")
        assertTrue(Modifier.isStatic(ktxClass.getMethod("getStorage", firebaseClass).modifiers))
        assertTrue(Modifier.isStatic(ktxClass.getMethod("storage", firebaseClass, String::class.java).modifiers))
        assertTrue(Modifier.isStatic(ktxClass.getMethod("storage", firebaseClass, appClass).modifiers))
        assertTrue(
            Modifier.isStatic(
                ktxClass.getMethod("storage", firebaseClass, appClass, String::class.java).modifiers
            )
        )

        val refClass = StorageReference::class.java
        assertTrue(Comparable::class.java.isAssignableFrom(refClass))
    }
}

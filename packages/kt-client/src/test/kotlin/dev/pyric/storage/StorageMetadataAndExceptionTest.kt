package dev.pyric.storage

import com.google.firebase.FirebaseApp
import com.google.firebase.FirebaseOptions
import com.google.firebase.firestore.FirebaseFirestoreException
import com.google.firebase.storage.FirebaseStorage
import com.google.firebase.storage.StorageException
import com.google.firebase.storage.StorageMetadata
import com.google.firebase.storage.storageMetadata
import org.junit.jupiter.api.AfterEach
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Assertions.assertSame
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.assertThrows
import java.time.Instant
import java.util.concurrent.CancellationException

class StorageMetadataAndExceptionTest {
    private val harnesses = mutableListOf<StorageMockBridgeHarness>()

    @AfterEach
    fun tearDown() {
        harnesses.forEach { it.closeAll() }
        harnesses.clear()
        FirebaseStorage.clearInstancesForTest()
        FirebaseApp.clearInstancesForTest()
    }

    @Test
    fun storageMetadataBuilderAndKtxDslBuildIsolatedImmutableSnapshots() {
        val empty = StorageMetadata()
        assertEquals("", empty.path)
        assertNull(empty.name)
        assertNull(empty.bucket)
        assertNull(empty.generation)
        assertNull(empty.metadataGeneration)
        assertEquals(0L, empty.sizeBytes)
        assertEquals(0L, empty.creationTimeMillis)
        assertEquals(0L, empty.updatedTimeMillis)
        assertNull(empty.md5Hash)
        assertNull(empty.contentType)
        assertTrue(empty.customMetadataKeys.isEmpty())

        val built = storageMetadata {
            contentType = "image/webp"
            cacheControl = "public, max-age=3600"
            contentDisposition = "inline; filename=\"hero.webp\""
            contentEncoding = "gzip"
            contentLanguage = "en-US"
            setCustomMetadata("author", "ada")
            setCustomMetadata("draft", "true")
            setCustomMetadata("removedKey", null)
        }

        assertEquals("image/webp", built.contentType)
        assertEquals("public, max-age=3600", built.cacheControl)
        assertEquals("inline; filename=\"hero.webp\"", built.contentDisposition)
        assertEquals("gzip", built.contentEncoding)
        assertEquals("en-US", built.contentLanguage)
        assertEquals("ada", built.getCustomMetadata("author"))
        assertEquals("true", built.getCustomMetadata("draft"))
        assertNull(built.getCustomMetadata("removedKey"))
        assertNull(built.getCustomMetadata(""))
        assertEquals(setOf("author", "draft"), built.customMetadataKeys)

        // Returned key set is unmodifiable.
        assertThrows<UnsupportedOperationException> {
            (built.customMetadataKeys as MutableSet<String>).add("mutated")
        }

        // Copy builder inherits settable fields without mutating original.
        val modified = StorageMetadata.Builder(built)
            .setContentType("image/png")
            .setCustomMetadata("author", "grace")
            .setCustomMetadata("draft", null)
            .build()

        assertEquals("image/webp", built.contentType)
        assertEquals("ada", built.getCustomMetadata("author"))
        assertEquals(setOf("author", "draft"), built.customMetadataKeys)

        assertEquals("image/png", modified.contentType)
        assertEquals("public, max-age=3600", modified.cacheControl)
        assertEquals("grace", modified.getCustomMetadata("author"))
        assertNull(modified.getCustomMetadata("draft"))
        assertEquals(setOf("author"), modified.customMetadataKeys)
    }

    @Test
    fun storageMetadataFromWireMapParsesServerSnapshotFieldsAndTimestamps() {
        val options = FirebaseOptions.Builder()
            .setProjectId("meta-proj")
            .setApiKey("k")
            .setApplicationId("a")
            .setStorageBucket("meta-proj.appspot.com")
            .build()
        val app = FirebaseApp.initializeApp("meta-app", options)
        val storage = FirebaseStorage.getInstance(app, StorageMockBridgeHarness().also { harnesses.add(it) }.newBridgeClient())
        val ref = storage.getReference("albums/2026/cover.jpg")

        val createdIso = "2026-11-20T12:30:45.250Z"
        val updatedIso = "2026-11-21T01:15:00.500Z"
        val wire = mapOf<String, Any?>(
            "bucket" to "meta-proj.appspot.com",
            "fullPath" to "albums/2026/cover.jpg",
            "name" to "cover.jpg",
            "size" to 98_765L,
            "generation" to "1770000123",
            "metageneration" to "4",
            "timeCreated" to createdIso,
            "updated" to updatedIso,
            "md5Hash" to "1B2M2Y8AsgTpgAmY7PhCfg==",
            "contentType" to "image/jpeg",
            "cacheControl" to "no-cache",
            "contentDisposition" to "inline",
            "contentEncoding" to "identity",
            "contentLanguage" to "en",
            "customMetadata" to mapOf("camera" to "pixel", "iso" to 400)
        )

        val parsed = StorageMetadata.fromWireMap(wire, ref)
        assertEquals("meta-proj.appspot.com", parsed.bucket)
        assertEquals("albums/2026/cover.jpg", parsed.path)
        assertEquals("cover.jpg", parsed.name)
        assertEquals(98_765L, parsed.sizeBytes)
        assertEquals("1770000123", parsed.generation)
        assertEquals("4", parsed.metadataGeneration)
        assertEquals(Instant.parse(createdIso).toEpochMilli(), parsed.creationTimeMillis)
        assertEquals(Instant.parse(updatedIso).toEpochMilli(), parsed.updatedTimeMillis)
        assertEquals("1B2M2Y8AsgTpgAmY7PhCfg==", parsed.md5Hash)
        assertEquals("image/jpeg", parsed.contentType)
        assertEquals("no-cache", parsed.cacheControl)
        assertEquals("inline", parsed.contentDisposition)
        assertEquals("identity", parsed.contentEncoding)
        assertEquals("en", parsed.contentLanguage)
        assertEquals("pixel", parsed.getCustomMetadata("camera"))
        assertEquals("400", parsed.getCustomMetadata("iso"))
        assertSame(ref, parsed.reference)
    }

    @Test
    fun storageExceptionConstantsAndWireMappingsMatchUpstreamAndroidSdk() {
        assertEquals(-13000, StorageException.ERROR_UNKNOWN)
        assertEquals(-13010, StorageException.ERROR_OBJECT_NOT_FOUND)
        assertEquals(-13011, StorageException.ERROR_BUCKET_NOT_FOUND)
        assertEquals(-13012, StorageException.ERROR_PROJECT_NOT_FOUND)
        assertEquals(-13013, StorageException.ERROR_QUOTA_EXCEEDED)
        assertEquals(-13020, StorageException.ERROR_NOT_AUTHENTICATED)
        assertEquals(-13021, StorageException.ERROR_NOT_AUTHORIZED)
        assertEquals(-13030, StorageException.ERROR_RETRY_LIMIT_EXCEEDED)
        assertEquals(-13031, StorageException.ERROR_INVALID_CHECKSUM)
        assertEquals(-13040, StorageException.ERROR_CANCELED)

        assertNull(StorageException.fromExceptionAndHttpCode(null, 200))

        val expectedWirePairs = listOf(
            "storage/object-not-found" to StorageException.ERROR_OBJECT_NOT_FOUND,
            "storage/bucket-not-found" to StorageException.ERROR_BUCKET_NOT_FOUND,
            "storage/project-not-found" to StorageException.ERROR_PROJECT_NOT_FOUND,
            "storage/quota-exceeded" to StorageException.ERROR_QUOTA_EXCEEDED,
            "payload-too-large" to StorageException.ERROR_QUOTA_EXCEEDED,
            "storage/unauthenticated" to StorageException.ERROR_NOT_AUTHENTICATED,
            "storage/unauthorized" to StorageException.ERROR_NOT_AUTHORIZED,
            "permission-denied" to StorageException.ERROR_NOT_AUTHORIZED,
            "storage/retry-limit-exceeded" to StorageException.ERROR_RETRY_LIMIT_EXCEEDED,
            "deadline-exceeded" to StorageException.ERROR_RETRY_LIMIT_EXCEEDED,
            "storage/invalid-checksum" to StorageException.ERROR_INVALID_CHECKSUM,
            "storage/canceled" to StorageException.ERROR_CANCELED,
            "storage/internal-error" to StorageException.ERROR_UNKNOWN
        )

        for ((wireCode, expectedErrorCode) in expectedWirePairs) {
            val fsEx = FirebaseFirestoreException(
                "Wire error for $wireCode",
                FirebaseFirestoreException.Code.UNKNOWN,
                wireCode = wireCode
            )
            val mapped = StorageException.fromException(fsEx)
            assertEquals(expectedErrorCode, mapped.errorCode, "Mismatch for wire code $wireCode")
            assertSame(fsEx, mapped.cause)
            assertEquals(
                expectedErrorCode == StorageException.ERROR_RETRY_LIMIT_EXCEEDED,
                mapped.isRecoverableException
            )
        }

        val fromHttp401 = StorageException.fromExceptionAndHttpCode(RuntimeException("auth"), 401)!!
        assertEquals(StorageException.ERROR_NOT_AUTHENTICATED, fromHttp401.errorCode)
        assertEquals(401, fromHttp401.httpResultCode)

        val fromHttp403 = StorageException.fromExceptionAndHttpCode(RuntimeException("rules"), 403)!!
        assertEquals(StorageException.ERROR_NOT_AUTHORIZED, fromHttp403.errorCode)
        assertEquals(403, fromHttp403.httpResultCode)
        assertFalse(fromHttp403.isRecoverableException)

        val fromCancel = StorageException.fromException(CancellationException("user canceled"))
        assertEquals(StorageException.ERROR_CANCELED, fromCancel.errorCode)
        assertSame(fromCancel, StorageException.fromException(fromCancel))
    }
}

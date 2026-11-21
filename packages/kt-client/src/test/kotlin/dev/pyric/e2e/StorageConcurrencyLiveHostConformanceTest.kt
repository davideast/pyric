package dev.pyric.e2e

import com.google.android.gms.tasks.Tasks
import com.google.android.gms.tasks.await as gmsAwait
import com.google.firebase.FirebaseApp
import com.google.firebase.FirebaseOptions
import com.google.firebase.auth.FirebaseAuth
import com.google.firebase.storage.FirebaseStorage
import com.google.firebase.storage.StorageException
import com.google.firebase.storage.storageMetadata
import com.google.firebase.storage.taskState
import dev.pyric.bridge.PyricBridgeClient
import java.nio.file.Path
import java.util.concurrent.CancellationException
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
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
import org.junit.jupiter.api.Assumptions
import org.junit.jupiter.api.BeforeEach
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.io.TempDir

class StorageConcurrencyLiveHostConformanceTest {

    private lateinit var liveBridgeUrl: String
    private lateinit var projectId: String
    private lateinit var defaultBucket: String
    private val bridges = mutableListOf<PyricBridgeClient>()

    @BeforeEach
    fun setUp() {
        val envUrl = System.getenv("PYRIC_LIVE_STORAGE_BRIDGE_URL")
        Assumptions.assumeTrue(
            !envUrl.isNullOrBlank(),
            "Skipping StorageConcurrencyLiveHostConformanceTest: PYRIC_LIVE_STORAGE_BRIDGE_URL is unset"
        )
        liveBridgeUrl = envUrl!!.trim()
        projectId = System.getenv("PYRIC_LIVE_STORAGE_PROJECT_ID")?.trim()
            ?.takeIf { it.isNotEmpty() }
            ?: "demo-kotlin-storage"
        defaultBucket = System.getenv("PYRIC_LIVE_STORAGE_DEFAULT_BUCKET")?.trim()
            ?.takeIf { it.isNotEmpty() }
            ?: "$projectId.appspot.com"

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

    private fun createAuthenticatedStorage(appName: String, email: String): FirebaseStorage {
        val options = FirebaseOptions.Builder()
            .setProjectId(projectId)
            .setApiKey("sandbox-api-key")
            .setApplicationId("1:424242424242:android:kotlinstorageconc")
            .setStorageBucket(defaultBucket)
            .build()
        val app = FirebaseApp.initializeApp(appName, options)
        val bridge = PyricBridgeClient(url = liveBridgeUrl)
        bridges.add(bridge)
        val auth = FirebaseAuth.getInstance(app, bridge)
        runBlocking {
            auth.createUserWithEmailAndPassword(email, "StrongPass!123").gmsAwait()
        }
        return FirebaseStorage.getInstance(app, bridge)
    }

    @Test
    fun liveMultiClientParallelUploadsAndDownloadsPreservePayloadIntegrity(
        @TempDir tempDir: Path
    ) {
        runBlocking {
            val storageA = createAuthenticatedStorage("live-conc-a", "conc-a@example.com")
            val storageB = createAuthenticatedStorage("live-conc-b", "conc-b@example.com")
            val clients = listOf(storageA, storageB)

            val payloads = (0 until 8).map { i ->
                ByteArray((i + 1) * 48 * 1024) { idx -> ((idx * 37 + i * 19) and 0xFF).toByte() }
            }

            coroutineScope {
                (0 until 8).map { i ->
                    async(Dispatchers.IO) {
                        val s = clients[i % 2]
                        val ref = s.getReference("pr3b/parallel/obj-$i.bin")
                        if (i % 2 == 0) {
                            ref.putBytes(payloads[i], storageMetadata { setCustomMetadata("idx", i.toString()) }).gmsAwait()
                        } else {
                            val src = tempDir.resolve("up-$i.bin").toFile().apply { writeBytes(payloads[i]) }
                            ref.putFile(src.toURI(), storageMetadata { setCustomMetadata("idx", i.toString()) }).ktxAwait()
                        }
                    }
                }.awaitAll()
            }

            coroutineScope {
                (0 until 8).map { i ->
                    async(Dispatchers.IO) {
                        val s = clients[(i + 1) % 2]
                        val ref = s.getReference("pr3b/parallel/obj-$i.bin")
                        val bytes = if (i % 2 == 0) {
                            val out = tempDir.resolve("down-$i.bin").toFile()
                            ref.getFile(out).gmsAwait()
                            out.readBytes()
                        } else {
                            ref.getStream().ktxAwait().stream.use { it.readBytes() }
                        }
                        assertArrayEquals(payloads[i], bytes)
                    }
                }.awaitAll()
            }
        }
    }

    @Test
    fun liveConcurrentSameObjectOverwritesSettleToConsistentWinningGeneration() {
        runBlocking {
            val storageA = createAuthenticatedStorage("live-race-a", "race-a@example.com")
            val storageB = createAuthenticatedStorage("live-race-b", "race-b@example.com")
            val clients = listOf(storageA, storageB)

            val variants = (0 until 6).map { i ->
                ByteArray(280 * 1024 + i * 1024) { idx -> ((idx * 23 + i * 41) and 0xFF).toByte() }
            }

            coroutineScope {
                variants.mapIndexed { i, bytes ->
                    async(Dispatchers.IO) {
                        clients[i % 2].getReference("pr3b/contested/latest.bin")
                            .putBytes(bytes, storageMetadata { setCustomMetadata("winner", i.toString()) })
                            .gmsAwait()
                    }
                }.awaitAll()
            }

            val finalMeta = storageA.getReference("pr3b/contested/latest.bin").getMetadata().gmsAwait()
            val winnerIdx = finalMeta.getCustomMetadata("winner")!!.toInt()
            val finalBytes = storageB.getReference("pr3b/contested/latest.bin").getBytes(1024L * 1024L).gmsAwait()
            assertArrayEquals(variants[winnerIdx], finalBytes)
            assertEquals(variants[winnerIdx].size.toLong(), finalMeta.sizeBytes)
        }
    }

    @Test
    fun liveCanceledMultiChunkUploadPreservesExistingObjectAndPropagatesErrorCanceled(
        @TempDir tempDir: Path
    ) {
        runBlocking {
            val storage = createAuthenticatedStorage("live-cancel-parity", "cancel-parity@example.com")
            val ref = storage.getReference("pr3b/cancel/protected.bin")
            val initialBytes = "committed-before-canceled-upload".toByteArray(Charsets.UTF_8)
            ref.putBytes(initialBytes).gmsAwait()

            // Upload 2 MiB via putFile, pause deterministically after chunk 0 (256 KiB), then cancel
            val largePayload = ByteArray(2 * 1024 * 1024) { (it and 0xFF).toByte() }
            val srcFile = tempDir.resolve("large-2m.bin").toFile().apply { writeBytes(largePayload) }
            val pausedAfterChunkLatch = CountDownLatch(1)
            val pauseTriggered = AtomicBoolean(false)
            val uploadTask = ref.putFile(srcFile.toURI())
            uploadTask.addOnProgressListener { snap ->
                if (snap.bytesTransferred in 1L until largePayload.size.toLong() &&
                    pauseTriggered.compareAndSet(false, true)
                ) {
                    uploadTask.pause()
                    pausedAfterChunkLatch.countDown()
                }
            }
            assertTrue(pausedAfterChunkLatch.await(10, TimeUnit.SECONDS))
            assertTrue(uploadTask.cancel())
            assertTrue(uploadTask.isCanceled)
            assertTrue(uploadTask.isComplete)
            assertFalse(uploadTask.isSuccessful)

            val flowErrors = CopyOnWriteArrayList<Throwable>()
            uploadTask.taskState.catch { flowErrors.add(it) }.toList()
            assertEquals(StorageException.ERROR_CANCELED, (flowErrors.single() as StorageException).errorCode)

            val gmsEx = assertThrows(StorageException::class.java) { runBlocking { uploadTask.gmsAwait() } }
            assertEquals(StorageException.ERROR_CANCELED, gmsEx.errorCode)

            val ktxEx = assertThrows(StorageException::class.java) { runBlocking { uploadTask.ktxAwait() } }
            assertEquals(StorageException.ERROR_CANCELED, ktxEx.errorCode)

            assertThrows(CancellationException::class.java) { Tasks.await(uploadTask) }
            assertArrayEquals(initialBytes, ref.getBytes(4096L).gmsAwait())

            // Deterministically pause and cancel a multi-chunk FileDownloadTask mid-transfer
            val bigRef = storage.getReference("pr3b/cancel/source-1m.bin")
            val oneMiB = 1024 * 1024
            bigRef.putBytes(ByteArray(oneMiB) { (it and 0x7F).toByte() }).gmsAwait()
            val dlPausedLatch = CountDownLatch(1)
            val dlPauseTriggered = AtomicBoolean(false)
            val dlTask = bigRef.getFile(tempDir.resolve("canceled-dl.bin").toFile())
            dlTask.addOnProgressListener { snap ->
                if (snap.bytesTransferred in 1L until oneMiB.toLong() &&
                    dlPauseTriggered.compareAndSet(false, true)
                ) {
                    dlTask.pause()
                    dlPausedLatch.countDown()
                }
            }
            assertTrue(dlPausedLatch.await(10, TimeUnit.SECONDS))
            assertTrue(dlTask.cancel())
            val dlEx = assertThrows(StorageException::class.java) { runBlocking { dlTask.gmsAwait() } }
            assertEquals(StorageException.ERROR_CANCELED, dlEx.errorCode)
            assertTrue(ref.activeUploadTasks.isEmpty())
            assertTrue(bigRef.activeDownloadTasks.isEmpty())
        }
    }
}

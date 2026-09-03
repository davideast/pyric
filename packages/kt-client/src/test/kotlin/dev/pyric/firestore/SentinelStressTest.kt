package dev.pyric.firestore

import com.google.android.gms.tasks.Tasks
import com.google.firebase.firestore.FieldValue
import com.google.firebase.firestore.Filter
import com.google.firebase.firestore.SetOptions
import dev.pyric.codecs.ValueCodec
import org.junit.jupiter.api.Assertions.assertDoesNotThrow
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertNotNull
import org.junit.jupiter.api.Assertions.assertThrows
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.BeforeEach
import org.junit.jupiter.api.DisplayName
import org.junit.jupiter.api.Nested
import org.junit.jupiter.api.Test

@DisplayName("Milestone 2 FieldValue Sentinel Validation & Defect Tests")
class SentinelStressTest {

    private lateinit var harness: ConformanceMockHarness

    @BeforeEach
    fun setUp() {
        harness = ConformanceMockHarness()
    }

    @Nested
    @DisplayName("FieldValue.delete() in setDoc & batch/tx mutations")
    inner class DeleteSentinelTests {

        @Test
        fun `DocumentReference set rejects FieldValue delete without merge`() {
            val doc = harness.firestore.document("users/alice")
            val ex = assertThrows(IllegalArgumentException::class.java) {
                doc.set(mapOf("toDelete" to FieldValue.delete()))
            }
            assertTrue(ex.message!!.contains("FieldValue.delete() can only appear in update() or set() with merge"))
        }

        @Test
        fun `DocumentReference set rejects nested FieldValue delete without merge`() {
            val doc = harness.firestore.document("users/alice")
            val ex = assertThrows(IllegalArgumentException::class.java) {
                doc.set(mapOf("nested" to mapOf("field" to FieldValue.delete())))
            }
            assertTrue(ex.message!!.contains("FieldValue.delete() can only appear in update() or set() with merge"))
        }

        @Test
        fun `DocumentReference set allows FieldValue delete with merge`() {
            val doc = harness.firestore.document("users/alice")
            val task = doc.set(mapOf("toDelete" to FieldValue.delete()), SetOptions.merge())
            assertNotNull(task)
        }

        @Test
        fun `WriteBatch set rejects FieldValue delete without merge`() {
            val batch = harness.firestore.batch()
            val doc = harness.firestore.document("users/alice")

            val ex = assertThrows(IllegalArgumentException::class.java) {
                batch.set(doc, mapOf("field" to FieldValue.delete()))
            }
            assertTrue(ex.message!!.contains("FieldValue.delete() can only appear in update() or set() with merge"))

            val exNested = assertThrows(IllegalArgumentException::class.java) {
                batch.set(doc, mapOf("nested" to mapOf("field" to FieldValue.delete())))
            }
            assertTrue(exNested.message!!.contains("FieldValue.delete() can only appear in update() or set() with merge"))
        }

        @Test
        fun `WriteBatch set allows FieldValue delete with merge`() {
            val batch = harness.firestore.batch()
            val doc = harness.firestore.document("users/alice")
            assertDoesNotThrow {
                batch.set(doc, mapOf("field" to FieldValue.delete()), SetOptions.merge())
            }
        }

        @Test
        fun `Transaction set rejects FieldValue delete without merge`() {
            val doc = harness.firestore.document("users/alice")
            val tx = com.google.firebase.firestore.Transaction(harness.firestore)

            val ex = assertThrows(IllegalArgumentException::class.java) {
                tx.set(doc, mapOf("field" to FieldValue.delete()))
            }
            assertTrue(ex.message!!.contains("FieldValue.delete() can only appear in update() or set() with merge"))

            val exNested = assertThrows(IllegalArgumentException::class.java) {
                tx.set(doc, mapOf("nested" to mapOf("field" to FieldValue.delete())))
            }
            assertTrue(exNested.message!!.contains("FieldValue.delete() can only appear in update() or set() with merge"))
        }

        @Test
        fun `Transaction set allows FieldValue delete with merge`() {
            val doc = harness.firestore.document("users/alice")
            val tx = com.google.firebase.firestore.Transaction(harness.firestore)
            assertDoesNotThrow {
                tx.set(doc, mapOf("field" to FieldValue.delete()), SetOptions.merge())
            }
        }
    }

    @Nested
    @DisplayName("Sentinels inside array transforms & query filters")
    inner class ArraySentinelTests {

        @Test
        fun `FieldValue arrayUnion rejects direct FieldValue sentinel element`() {
            val ex1 = assertThrows(IllegalArgumentException::class.java) {
                FieldValue.arrayUnion(FieldValue.delete())
            }
            assertTrue(ex1.message!!.contains("FieldValue sentinels cannot be nested inside arrayUnion"))

            val ex2 = assertThrows(IllegalArgumentException::class.java) {
                FieldValue.arrayUnion(FieldValue.serverTimestamp())
            }
            assertTrue(ex2.message!!.contains("FieldValue sentinels cannot be nested inside arrayUnion"))
        }

        @Test
        fun `FieldValue arrayRemove rejects direct FieldValue sentinel element`() {
            val ex = assertThrows(IllegalArgumentException::class.java) {
                FieldValue.arrayRemove(FieldValue.delete())
            }
            assertTrue(ex.message!!.contains("FieldValue sentinels cannot be nested inside arrayRemove"))
        }

        @Test
        fun `FieldValue arrayUnion and arrayRemove reject nested FieldValue in collection or map`() {
            val ex1 = assertThrows(IllegalArgumentException::class.java) {
                FieldValue.arrayUnion(listOf(FieldValue.delete()))
            }
            assertTrue(ex1.message!!.contains("FieldValue sentinels cannot be nested inside arrayUnion"))

            val ex2 = assertThrows(IllegalArgumentException::class.java) {
                FieldValue.arrayUnion(mapOf("key" to FieldValue.serverTimestamp()))
            }
            assertTrue(ex2.message!!.contains("FieldValue sentinels cannot be nested inside arrayUnion"))

            val ex3 = assertThrows(IllegalArgumentException::class.java) {
                FieldValue.arrayRemove(listOf(FieldValue.delete()))
            }
            assertTrue(ex3.message!!.contains("FieldValue sentinels cannot be nested inside arrayRemove"))

            val ex4 = assertThrows(IllegalArgumentException::class.java) {
                FieldValue.arrayRemove(mapOf("key" to FieldValue.serverTimestamp()))
            }
            assertTrue(ex4.message!!.contains("FieldValue sentinels cannot be nested inside arrayRemove"))
        }

        @Test
        fun `ValueCodec encodeValue rejects ArrayUnionSentinel with nested sentinels`() {
            val rawSentinel = FieldValue.ArrayUnionSentinel(listOf(listOf(FieldValue.delete())))
            val ex = assertThrows(IllegalArgumentException::class.java) {
                ValueCodec.encodeValue(rawSentinel)
            }
            assertTrue(ex.message!!.contains("FieldValue sentinels cannot be nested inside arrayUnion"))
        }

        @Test
        fun `Query filter rejects FieldValue sentinel`() {
            val ex = assertThrows(IllegalArgumentException::class.java) {
                val q = harness.firestore.collection("users").where(Filter.equalTo("ts", FieldValue.serverTimestamp()))
                q.toTargetDescriptor()
            }
            assertTrue(ex.message!!.contains("FieldValue sentinels cannot be used in query filters"))
        }
    }
}

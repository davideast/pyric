package dev.pyric.firestore

import com.google.firebase.Timestamp
import com.google.firebase.firestore.FieldPath
import com.google.firebase.firestore.FieldValue
import com.google.firebase.firestore.Filter
import com.google.firebase.firestore.SetOptions
import dev.pyric.codecs.QueryCompiler
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
import java.util.Date

@DisplayName("Milestone 2 Iteration 2 Adversarial Stress Tests")
class M2I2AdversarialStressTest {

    private lateinit var harness: ConformanceMockHarness

    @BeforeEach
    fun setUp() {
        harness = ConformanceMockHarness()
    }

    // ── 1. Timestamp Date Conversion & Matrix ───────────────────────────────────

    @Nested
    @DisplayName("Defect 1: Timestamp(Date) Conversion & Negative Matrix")
    inner class TimestampTests {

        @Test
        fun `Timestamp Date minus 500ms assert seconds minus 1 and nanos 500M`() {
            val date = Date(-500L)
            val ts = Timestamp(date)

            assertEquals(-1L, ts.seconds)
            assertEquals(500_000_000, ts.nanoseconds)
            assertEquals(date, ts.toDate())
            assertEquals(-500L, ts.toDate().time)
        }

        @Test
        fun `Timestamp exhaustive pre-1970 and epoch boundary matrix`() {
            val testCases = listOf(
                // ms to (expected seconds, expected nanos)
                -1L to (-1L to 999_000_000),
                -500L to (-1L to 500_000_000),
                -999L to (-1L to 1_000_000),
                -1000L to (-1L to 0),
                -1001L to (-2L to 999_000_000),
                -1500L to (-2L to 500_000_000),
                -1999L to (-2L to 1_000_000),
                -2000L to (-2L to 0),
                -2001L to (-3L to 999_000_000),
                0L to (0L to 0),
                1L to (0L to 1_000_000),
                500L to (0L to 500_000_000),
                999L to (0L to 999_000_000),
                1000L to (1L to 0),
                1001L to (1L to 1_000_000)
            )

            for ((ms, expected) in testCases) {
                val (expectedSec, expectedNanos) = expected
                val date = Date(ms)
                val ts = Timestamp(date)
                assertEquals(expectedSec, ts.seconds, "Failed seconds for ms=$ms")
                assertEquals(expectedNanos, ts.nanoseconds, "Failed nanos for ms=$ms")
                assertEquals(date, ts.toDate(), "Failed toDate roundtrip for ms=$ms")
            }
        }

        @Test
        fun `Timestamp ordering and equality for negative timestamps`() {
            val t1 = Timestamp(Date(-2000L))
            val t2 = Timestamp(Date(-1500L))
            val t3 = Timestamp(Date(-1000L))
            val t4 = Timestamp(Date(-500L))
            val t5 = Timestamp(Date(0L))

            assertTrue(t1 < t2)
            assertTrue(t2 < t3)
            assertTrue(t3 < t4)
            assertTrue(t4 < t5)

            val t4Copy = Timestamp(-1L, 500_000_000)
            assertEquals(t4, t4Copy)
            assertEquals(t4.hashCode(), t4Copy.hashCode())
        }

        @Test
        fun `Timestamp Date min and max supported boundaries`() {
            val minDate = Date(-62135596800000L)
            val minTs = Timestamp(minDate)
            assertEquals(-62135596800L, minTs.seconds)
            assertEquals(0, minTs.nanoseconds)
            assertEquals(minDate, minTs.toDate())

            val maxDate = Date(253402300799000L)
            val maxTs = Timestamp(maxDate)
            assertEquals(253402300799L, maxTs.seconds)
            assertEquals(0, maxTs.nanoseconds)
            assertEquals(maxDate, maxTs.toDate())

            assertThrows(IllegalArgumentException::class.java) {
                Timestamp(Date(-62135596800001L))
            }
            assertThrows(IllegalArgumentException::class.java) {
                Timestamp(Date(253402300800000L))
            }
        }
    }

    // ── 2. Delete Sentinel Rejections in Batch and Transaction ─────────────────

    @Nested
    @DisplayName("Defect 2: Delete Sentinel Rejection in WriteBatch and Transaction")
    inner class DeleteSentinelTests {

        @Test
        fun `WriteBatch set non-merge throws IllegalArgumentException on direct and nested delete`() {
            val batch = harness.firestore.batch()
            val doc = harness.firestore.document("users/bob")

            // Top-level delete without merge
            assertThrows(IllegalArgumentException::class.java) {
                batch.set(doc, mapOf("field" to FieldValue.delete()))
            }
            // Explicit SetOptions.overwrite()
            assertThrows(IllegalArgumentException::class.java) {
                batch.set(doc, mapOf("field" to FieldValue.delete()), SetOptions.overwrite())
            }
            // Deeply nested delete
            assertThrows(IllegalArgumentException::class.java) {
                batch.set(doc, mapOf("nested" to mapOf("level2" to mapOf("target" to FieldValue.delete()))))
            }
            // Delete inside a list inside map
            assertThrows(IllegalArgumentException::class.java) {
                batch.set(doc, mapOf("items" to listOf(FieldValue.delete())))
            }
            // Delete inside map inside list
            assertThrows(IllegalArgumentException::class.java) {
                batch.set(doc, mapOf("items" to listOf(mapOf("k" to FieldValue.delete()))))
            }
            // Delete inside array inside map
            assertThrows(IllegalArgumentException::class.java) {
                batch.set(doc, mapOf("items" to arrayOf(FieldValue.delete())))
            }
        }

        @Test
        fun `WriteBatch set merge succeeds with delete sentinel`() {
            val batch = harness.firestore.batch()
            val doc = harness.firestore.document("users/bob")

            assertDoesNotThrow {
                batch.set(doc, mapOf("field" to FieldValue.delete()), SetOptions.merge())
            }
            assertDoesNotThrow {
                batch.set(doc, mapOf("nested" to mapOf("field" to FieldValue.delete())), SetOptions.merge())
            }
            assertDoesNotThrow {
                batch.set(doc, mapOf("field" to FieldValue.delete()), SetOptions.mergeFields("field"))
            }
            assertDoesNotThrow {
                batch.set(doc, mapOf("field" to FieldValue.delete()), SetOptions.mergeFields(listOf("field")))
            }
        }

        @Test
        fun `Transaction set non-merge throws IllegalArgumentException on direct and nested delete`() {
            val tx = com.google.firebase.firestore.Transaction(harness.firestore)
            val doc = harness.firestore.document("users/bob")

            // Top-level delete without merge
            assertThrows(IllegalArgumentException::class.java) {
                tx.set(doc, mapOf("field" to FieldValue.delete()))
            }
            // Explicit SetOptions.overwrite()
            assertThrows(IllegalArgumentException::class.java) {
                tx.set(doc, mapOf("field" to FieldValue.delete()), SetOptions.overwrite())
            }
            // Deeply nested delete
            assertThrows(IllegalArgumentException::class.java) {
                tx.set(doc, mapOf("nested" to mapOf("level2" to mapOf("target" to FieldValue.delete()))))
            }
            // Delete inside list
            assertThrows(IllegalArgumentException::class.java) {
                tx.set(doc, mapOf("items" to listOf(FieldValue.delete())))
            }
            // Delete inside map inside list
            assertThrows(IllegalArgumentException::class.java) {
                tx.set(doc, mapOf("items" to listOf(mapOf("k" to FieldValue.delete()))))
            }
            // Delete inside array
            assertThrows(IllegalArgumentException::class.java) {
                tx.set(doc, mapOf("items" to arrayOf(FieldValue.delete())))
            }
        }

        @Test
        fun `Transaction set merge succeeds with delete sentinel`() {
            val tx = com.google.firebase.firestore.Transaction(harness.firestore)
            val doc = harness.firestore.document("users/bob")

            assertDoesNotThrow {
                tx.set(doc, mapOf("field" to FieldValue.delete()), SetOptions.merge())
            }
            assertDoesNotThrow {
                tx.set(doc, mapOf("nested" to mapOf("field" to FieldValue.delete())), SetOptions.merge())
            }
            assertDoesNotThrow {
                tx.set(doc, mapOf("field" to FieldValue.delete()), SetOptions.mergeFields("field"))
            }
            assertDoesNotThrow {
                tx.set(doc, mapOf("field" to FieldValue.delete()), SetOptions.mergeFields(listOf("field")))
            }
        }
    }

    // ── 3. Nested Array Sentinel Rejections ───────────────────────────────────

    @Nested
    @DisplayName("Defect 3: Nested Array Sentinel Rejections")
    inner class NestedArraySentinelTests {

        @Test
        fun `arrayUnion rejects nested delete sentinel in list and arrayRemove rejects serverTimestamp in map`() {
            // FieldValue.arrayUnion(listOf(FieldValue.delete())) throws IllegalArgumentException
            val ex1 = assertThrows(IllegalArgumentException::class.java) {
                FieldValue.arrayUnion(listOf(FieldValue.delete()))
            }
            assertTrue(ex1.message!!.contains("FieldValue sentinels cannot be nested inside arrayUnion"))

            // FieldValue.arrayRemove(mapOf("k" to FieldValue.serverTimestamp())) throws IllegalArgumentException
            val ex2 = assertThrows(IllegalArgumentException::class.java) {
                FieldValue.arrayRemove(mapOf("k" to FieldValue.serverTimestamp()))
            }
            assertTrue(ex2.message!!.contains("FieldValue sentinels cannot be nested inside arrayRemove"))
        }

        @Test
        fun `arrayUnion and arrayRemove reject all sentinel types at any nesting depth`() {
            val sentinels = listOf(
                FieldValue.delete(),
                FieldValue.serverTimestamp(),
                FieldValue.increment(1),
                FieldValue.increment(1.5),
                FieldValue.arrayUnion("dummy"),
                FieldValue.arrayRemove("dummy")
            )

            for (sentinel in sentinels) {
                // Direct
                assertThrows(IllegalArgumentException::class.java) {
                    FieldValue.arrayUnion(sentinel)
                }
                assertThrows(IllegalArgumentException::class.java) {
                    FieldValue.arrayRemove(sentinel)
                }
                // Nested in list
                assertThrows(IllegalArgumentException::class.java) {
                    FieldValue.arrayUnion(listOf(sentinel))
                }
                assertThrows(IllegalArgumentException::class.java) {
                    FieldValue.arrayRemove(listOf(sentinel))
                }
                // Nested in map
                assertThrows(IllegalArgumentException::class.java) {
                    FieldValue.arrayUnion(mapOf("key" to sentinel))
                }
                assertThrows(IllegalArgumentException::class.java) {
                    FieldValue.arrayRemove(mapOf("key" to sentinel))
                }
                // Deeply nested: list -> map -> array -> sentinel
                assertThrows(IllegalArgumentException::class.java) {
                    FieldValue.arrayUnion(listOf(mapOf("nested" to arrayOf(sentinel))))
                }
                assertThrows(IllegalArgumentException::class.java) {
                    FieldValue.arrayRemove(listOf(mapOf("nested" to arrayOf(sentinel))))
                }
            }
        }

        @Test
        fun `ValueCodec encodeValue defense-in-depth rejects nested sentinels in raw sentinel objects`() {
            val unionRaw = FieldValue.ArrayUnionSentinel(listOf(listOf(FieldValue.delete())))
            val exUnion = assertThrows(IllegalArgumentException::class.java) {
                ValueCodec.encodeValue(unionRaw)
            }
            assertTrue(exUnion.message!!.contains("FieldValue sentinels cannot be nested inside arrayUnion"))

            val removeRaw = FieldValue.ArrayRemoveSentinel(listOf(mapOf("k" to FieldValue.serverTimestamp())))
            val exRemove = assertThrows(IllegalArgumentException::class.java) {
                ValueCodec.encodeValue(removeRaw)
            }
            assertTrue(exRemove.message!!.contains("FieldValue sentinels cannot be nested inside arrayRemove"))
        }

        @Test
        fun `arrayUnion and arrayRemove accept standard nested data without sentinels`() {
            assertDoesNotThrow {
                val u = FieldValue.arrayUnion("str", 123, true, listOf("a", "b"), mapOf("x" to 1, "y" to listOf(2, 3)))
                val encoded = ValueCodec.encodeValue(u) as Map<*, *>
                assertEquals("arrayUnion", encoded["__sentinel"])
                assertNotNull(encoded["values"])
            }

            assertDoesNotThrow {
                val r = FieldValue.arrayRemove("str", 123, true, listOf("a", "b"), mapOf("x" to 1, "y" to listOf(2, 3)))
                val encoded = ValueCodec.encodeValue(r) as Map<*, *>
                assertEquals("arrayRemove", encoded["__sentinel"])
                assertNotNull(encoded["values"])
            }
        }
    }

    // ── 4. Query Array Validations ─────────────────────────────────────────────

    @Nested
    @DisplayName("Defect 4: Query Array Validations and Document ID Constraints")
    inner class QueryArrayTests {

        @Test
        fun `query whereNotIn and whereArrayContainsAny throw on emptyList`() {
            val coll = harness.firestore.collection("items")

            // query.whereNotIn("field", emptyList()) throws IllegalArgumentException
            val exNotIn = assertThrows(IllegalArgumentException::class.java) {
                coll.whereNotIn("field", emptyList<Any>())
            }
            assertTrue(exNotIn.message!!.contains("A non-empty array is required for 'not-in' filters"))

            // query.whereArrayContainsAny("field", emptyList()) throws IllegalArgumentException
            val exContainsAny = assertThrows(IllegalArgumentException::class.java) {
                coll.whereArrayContainsAny("field", emptyList<Any>())
            }
            assertTrue(exContainsAny.message!!.contains("A non-empty array is required for 'array-contains-any' filters"))

            // query.whereIn("field", emptyList()) also throws IllegalArgumentException
            val exIn = assertThrows(IllegalArgumentException::class.java) {
                coll.whereIn("field", emptyList<Any>())
            }
            assertTrue(exIn.message!!.contains("A non-empty array is required for 'in' filters"))
        }

        @Test
        fun `query whereNotIn and whereArrayContainsAny with FieldPath overload throw on emptyList`() {
            val coll = harness.firestore.collection("items")
            val path = FieldPath.of("a", "b")

            assertThrows(IllegalArgumentException::class.java) {
                coll.whereNotIn(path, emptyList<Any>())
            }
            assertThrows(IllegalArgumentException::class.java) {
                coll.whereArrayContainsAny(path, emptyList<Any>())
            }
            assertThrows(IllegalArgumentException::class.java) {
                coll.whereIn(path, emptyList<Any>())
            }
        }

        @Test
        fun `array filters validate upper bound of 30 elements`() {
            val coll = harness.firestore.collection("items")
            val exactly30 = (1..30).toList()
            val oversized31 = (1..31).toList()

            // 30 elements succeeds
            assertDoesNotThrow { coll.whereIn("f", exactly30) }
            assertDoesNotThrow { coll.whereNotIn("f", exactly30) }
            assertDoesNotThrow { coll.whereArrayContainsAny("f", exactly30) }

            // 31 elements throws
            val exIn = assertThrows(IllegalArgumentException::class.java) { coll.whereIn("f", oversized31) }
            assertTrue(exIn.message!!.contains("support a maximum of 30 elements"))

            val exNotIn = assertThrows(IllegalArgumentException::class.java) { coll.whereNotIn("f", oversized31) }
            assertTrue(exNotIn.message!!.contains("support a maximum of 30 elements"))

            val exContainsAny = assertThrows(IllegalArgumentException::class.java) { coll.whereArrayContainsAny("f", oversized31) }
            assertTrue(exContainsAny.message!!.contains("support a maximum of 30 elements"))
        }

        @Test
        fun `composite filters containing invalid array filters throw immediately`() {
            val coll = harness.firestore.collection("items")

            assertThrows(IllegalArgumentException::class.java) {
                coll.where(Filter.and(
                    Filter.equalTo("status", "open"),
                    Filter.notInArray("tag", emptyList<String>())
                ))
            }

            assertThrows(IllegalArgumentException::class.java) {
                coll.where(Filter.or(
                    Filter.equalTo("status", "open"),
                    Filter.arrayContainsAny("tag", emptyList<String>())
                ))
            }
        }

        @Test
        fun `documentId constraints enforce array contains restrictions while allowing in and notIn`() {
            val coll = harness.firestore.collection("items")

            // ARRAY_CONTAINS on documentId throws
            val ex1 = assertThrows(IllegalArgumentException::class.java) {
                coll.whereArrayContains(FieldPath.documentId(), "doc1")
            }
            assertTrue(ex1.message!!.contains("You can't perform 'array-contains' queries on FieldPath.documentId()"))

            // ARRAY_CONTAINS_ANY on documentId throws
            val ex2 = assertThrows(IllegalArgumentException::class.java) {
                coll.whereArrayContainsAny(FieldPath.documentId(), listOf("doc1", "doc2"))
            }
            assertTrue(ex2.message!!.contains("You can't perform 'array-contains-any' queries on FieldPath.documentId()"))

            // IN and NOT_IN on documentId are valid and permitted
            assertDoesNotThrow {
                val q = coll.whereIn(FieldPath.documentId(), listOf("doc1", "doc2"))
                val target = q.toTargetDescriptor()
                assertNotNull(target["constraints"])
            }
            assertDoesNotThrow {
                val q = coll.whereNotIn(FieldPath.documentId(), listOf("doc1", "doc2"))
                val target = q.toTargetDescriptor()
                assertNotNull(target["constraints"])
            }
        }

        @Test
        fun `QueryCompiler compileTarget rejects non-positive limit and limitToLast`() {
            // limitValue <= 0
            assertThrows(IllegalArgumentException::class.java) {
                QueryCompiler.compileTarget("col", "col", false, emptyList(), emptyList(), 0L, null, emptyList())
            }
            assertThrows(IllegalArgumentException::class.java) {
                QueryCompiler.compileTarget("col", "col", false, emptyList(), emptyList(), -1L, null, emptyList())
            }

            // limitToLastValue <= 0
            val order = listOf(dev.pyric.codecs.OrderBy("f", dev.pyric.codecs.Direction.ASCENDING))
            assertThrows(IllegalArgumentException::class.java) {
                QueryCompiler.compileTarget("col", "col", false, emptyList(), order, null, 0L, emptyList())
            }
            assertThrows(IllegalArgumentException::class.java) {
                QueryCompiler.compileTarget("col", "col", false, emptyList(), order, null, -5L, emptyList())
            }
        }
    }
}

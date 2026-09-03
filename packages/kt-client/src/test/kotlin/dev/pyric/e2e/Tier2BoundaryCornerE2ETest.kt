package dev.pyric.e2e

import com.google.android.gms.tasks.Tasks
import com.google.firebase.Timestamp
import com.google.firebase.firestore.FieldPath
import com.google.firebase.firestore.FieldValue
import com.google.firebase.firestore.FirebaseFirestore
import dev.pyric.codecs.Direction
import dev.pyric.codecs.OrderBy
import dev.pyric.codecs.QueryCompiler
import org.junit.jupiter.api.Assertions.assertDoesNotThrow
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertThrows
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.BeforeEach
import org.junit.jupiter.api.DisplayName
import org.junit.jupiter.api.Test
import java.util.Date

@DisplayName("Tier 2 Boundary & Corner E2E Tests")
class Tier2BoundaryCornerE2ETest {

    private lateinit var harness: E2ETestHarness
    private lateinit var firestore: FirebaseFirestore

    @BeforeEach
    fun setUp() {
        harness = E2ETestHarness()
        firestore = harness.createClient("tier2-app")
    }

    // ── 1. Empty Values & String Boundaries ────────────────────────────────

    @Test
    fun testEmptyStringInFieldValues() {
        val docRef = firestore.collection("boundary-strings").document("empty-vals")
        Tasks.await(docRef.set(mapOf("emptyStr" to "", "nested" to mapOf("innerEmpty" to ""))))

        val snap = Tasks.await(docRef.get())
        assertEquals("", snap.getString("emptyStr"))
        assertEquals("", snap.getString("nested.innerEmpty"))
    }

    @Test
    fun testEmptyCollectionsAndLists() {
        val docRef = firestore.collection("boundary-strings").document("empty-collections")
        Tasks.await(docRef.set(mapOf("emptyList" to emptyList<Any>(), "emptyMap" to emptyMap<String, Any>())))

        val snap = Tasks.await(docRef.get())
        assertEquals(emptyList<Any>(), snap.get("emptyList"))
        assertEquals(emptyMap<String, Any>(), snap.get("emptyMap"))
    }

    @Test
    fun testSpecialCharactersInDocumentId() {
        val docRef = firestore.collection("boundary-ids").document("doc_with-special.chars!@123")
        Tasks.await(docRef.set(mapOf("exists" to true)))

        val snap = Tasks.await(docRef.get())
        assertTrue(snap.exists())
        assertEquals("doc_with-special.chars!@123", snap.id)
    }

    @Test
    fun testSpecialUnicodeInFieldNames() {
        val docRef = firestore.collection("boundary-unicode").document("fields")
        val data = mapOf(
            "名前" to "太郎",
            "🚀rocket" to "launch",
            "مرحبا" to "arabic",
            "résumé" to "document"
        )
        Tasks.await(docRef.set(data))

        val snap = Tasks.await(docRef.get())
        assertEquals("太郎", snap.getString("名前"))
        assertEquals("launch", snap.getString("🚀rocket"))
        assertEquals("arabic", snap.getString("مرحبا"))
        assertEquals("document", snap.getString("résumé"))
    }

    @Test
    fun testSpecialUnicodeInValues() {
        val docRef = firestore.collection("boundary-unicode").document("values")
        val content = "🎉 Multibyte UTF-8 🚀 漢字 العربية 𠮷野家"
        Tasks.await(docRef.set(mapOf("content" to content)))

        val snap = Tasks.await(docRef.get())
        assertEquals(content, snap.getString("content"))
    }

    @Test
    fun testUnicodeCharactersInDocumentId() {
        val docRef = firestore.collection("boundary-ids").document("日本語-doc-🎉")
        Tasks.await(docRef.set(mapOf("valid" to true)))

        val snap = Tasks.await(docRef.get())
        assertTrue(snap.exists())
        assertEquals("日本語-doc-🎉", snap.id)
    }

    // ── 2. Limits and Query Boundaries ─────────────────────────────────────

    @Test
    fun testLimitZeroThrowsIllegalArgumentException() {
        val col = firestore.collection("boundary-limits")
        assertThrows(IllegalArgumentException::class.java) { col.limit(0) }
    }

    @Test
    fun testLimitNegativeThrowsIllegalArgumentException() {
        val col = firestore.collection("boundary-limits")
        assertThrows(IllegalArgumentException::class.java) { col.limit(-1) }
        assertThrows(IllegalArgumentException::class.java) { col.limit(-100) }
    }

    @Test
    fun testLimitToLastZeroThrowsIllegalArgumentException() {
        val col = firestore.collection("boundary-limits")
        assertThrows(IllegalArgumentException::class.java) { col.limitToLast(0) }
    }

    @Test
    fun testLimitToLastNegativeThrowsIllegalArgumentException() {
        val col = firestore.collection("boundary-limits")
        assertThrows(IllegalArgumentException::class.java) { col.limitToLast(-5) }
    }

    @Test
    fun testQueryCompilerDirectLimitValidation() {
        assertThrows(IllegalArgumentException::class.java) {
            QueryCompiler.compileTarget("col", "col", false, emptyList(), emptyList(), 0L, null, emptyList())
        }
        assertThrows(IllegalArgumentException::class.java) {
            QueryCompiler.compileTarget("col", "col", false, emptyList(), emptyList(), -10L, null, emptyList())
        }
        val order = listOf(OrderBy("f", Direction.ASCENDING))
        assertThrows(IllegalArgumentException::class.java) {
            QueryCompiler.compileTarget("col", "col", false, emptyList(), order, null, 0L, emptyList())
        }
        assertThrows(IllegalArgumentException::class.java) {
            QueryCompiler.compileTarget("col", "col", false, emptyList(), order, null, -1L, emptyList())
        }
    }

    @Test
    fun testLimitLargeValueExceedingStoreSize() {
        val col = firestore.collection("boundary-large-limit")
        Tasks.await(col.document("1").set(mapOf("num" to 1)))
        Tasks.await(col.document("2").set(mapOf("num" to 2)))

        val snap = Tasks.await(col.limit(1000).get())
        assertEquals(2, snap.size())
    }

    @Test
    fun testLimitToLastWithoutOrderByThrowsOnCompileTarget() {
        val query = firestore.collection("boundary-limits").limitToLast(5)
        assertThrows(IllegalArgumentException::class.java) {
            query.toTargetDescriptor()
        }
    }

    // ── 3. Extreme Timestamps ──────────────────────────────────────────────

    @Test
    fun testPre1970TimestampNegativeSeconds() {
        val ts = Timestamp(-1000L, 0)
        assertEquals(-1000L, ts.seconds)
        assertEquals(0, ts.nanoseconds)

        val docRef = firestore.collection("boundary-ts").document("pre-1970")
        Tasks.await(docRef.set(mapOf("ts" to ts)))

        val snap = Tasks.await(docRef.get())
        assertEquals(ts, snap.getTimestamp("ts"))
    }

    @Test
    fun testPre1970TimestampDateMinus500Ms() {
        val date = Date(-500L)
        val ts = Timestamp(date)
        assertEquals(-1L, ts.seconds)
        assertEquals(500_000_000, ts.nanoseconds)
        assertEquals(date, ts.toDate())

        val docRef = firestore.collection("boundary-ts").document("minus-500ms")
        Tasks.await(docRef.set(mapOf("ts" to ts)))

        val snap = Tasks.await(docRef.get())
        assertEquals(ts, snap.getTimestamp("ts"))
    }

    @Test
    fun testPre1970TimestampDateMinus1Ms() {
        val date = Date(-1L)
        val ts = Timestamp(date)
        assertEquals(-1L, ts.seconds)
        assertEquals(999_000_000, ts.nanoseconds)
        assertEquals(date, ts.toDate())
    }

    @Test
    fun testEpochTimestampZeroSecondsZeroNanos() {
        val ts = Timestamp(Date(0L))
        assertEquals(0L, ts.seconds)
        assertEquals(0, ts.nanoseconds)
        assertEquals(Date(0L), ts.toDate())
    }

    @Test
    fun testExtremeFutureTimestampYear9999() {
        val ts = Timestamp(253402300799L, 999_999_999)
        assertEquals(253402300799L, ts.seconds)
        assertEquals(999_999_999, ts.nanoseconds)

        val docRef = firestore.collection("boundary-ts").document("year-9999")
        Tasks.await(docRef.set(mapOf("ts" to ts)))

        val snap = Tasks.await(docRef.get())
        assertEquals(ts, snap.getTimestamp("ts"))
    }

    @Test
    fun testTimestampMinBoundarySeconds() {
        val minTs = Timestamp(-62135596800L, 0)
        assertEquals(-62135596800L, minTs.seconds)
        assertEquals(0, minTs.nanoseconds)
    }

    @Test
    fun testTimestampOutOfBoundsSecondsThrows() {
        assertThrows(IllegalArgumentException::class.java) {
            Timestamp(-62135596801L, 0)
        }
        assertThrows(IllegalArgumentException::class.java) {
            Timestamp(253402300800L, 0)
        }
    }

    @Test
    fun testTimestampNanosBoundaryValidations() {
        assertDoesNotThrow { Timestamp(0L, 0) }
        assertDoesNotThrow { Timestamp(0L, 999_999_999) }
        assertThrows(IllegalArgumentException::class.java) { Timestamp(0L, -1) }
        assertThrows(IllegalArgumentException::class.java) { Timestamp(0L, 1_000_000_000) }
    }

    // ── 4. Array Filters (Max 30 Elements) ─────────────────────────────────

    @Test
    fun testWhereInExactly30ElementsSucceeds() {
        val col = firestore.collection("boundary-arrays")
        val list30 = (1..30).toList()
        assertDoesNotThrow { col.whereIn("val", list30) }
    }

    @Test
    fun testWhereIn31ElementsThrows() {
        val col = firestore.collection("boundary-arrays")
        val list31 = (1..31).toList()
        val ex = assertThrows(IllegalArgumentException::class.java) { col.whereIn("val", list31) }
        assertTrue(ex.message!!.contains("support a maximum of 30 elements"))
    }

    @Test
    fun testWhereNotInExactly30ElementsSucceeds() {
        val col = firestore.collection("boundary-arrays")
        val list30 = (1..30).toList()
        assertDoesNotThrow { col.whereNotIn("val", list30) }
    }

    @Test
    fun testWhereNotIn31ElementsThrows() {
        val col = firestore.collection("boundary-arrays")
        val list31 = (1..31).toList()
        val ex = assertThrows(IllegalArgumentException::class.java) { col.whereNotIn("val", list31) }
        assertTrue(ex.message!!.contains("support a maximum of 30 elements"))
    }

    @Test
    fun testWhereArrayContainsAnyExactly30ElementsSucceeds() {
        val col = firestore.collection("boundary-arrays")
        val list30 = (1..30).toList()
        assertDoesNotThrow { col.whereArrayContainsAny("tags", list30) }
    }

    @Test
    fun testWhereArrayContainsAny31ElementsThrows() {
        val col = firestore.collection("boundary-arrays")
        val list31 = (1..31).toList()
        val ex = assertThrows(IllegalArgumentException::class.java) { col.whereArrayContainsAny("tags", list31) }
        assertTrue(ex.message!!.contains("support a maximum of 30 elements"))
    }

    @Test
    fun testArrayFiltersEmptyListThrows() {
        val col = firestore.collection("boundary-arrays")
        assertThrows(IllegalArgumentException::class.java) { col.whereIn("val", emptyList<Any>()) }
        assertThrows(IllegalArgumentException::class.java) { col.whereNotIn("val", emptyList<Any>()) }
        assertThrows(IllegalArgumentException::class.java) { col.whereArrayContainsAny("tags", emptyList<Any>()) }
    }

    // ── 5. Deep Nesting & Defense-in-Depth ──────────────────────────────────

    @Test
    fun testDeeplyNestedMaps() {
        val docRef = firestore.collection("boundary-nesting").document("deep-map")
        // 10 levels of nesting
        var nested: Any = "leaf-value"
        for (level in 10 downTo 1) {
            nested = mapOf("level$level" to nested)
        }
        @Suppress("UNCHECKED_CAST")
        Tasks.await(docRef.set(nested as Map<String, Any?>))

        val snap = Tasks.await(docRef.get())
        assertEquals(
            "leaf-value",
            snap.getString("level1.level2.level3.level4.level5.level6.level7.level8.level9.level10")
        )
    }

    @Test
    fun testDeeplyNestedLists() {
        val docRef = firestore.collection("boundary-nesting").document("deep-list")
        val matrix = listOf(listOf(listOf(1, 2), listOf(3, 4)), listOf(listOf(5, 6)))
        Tasks.await(docRef.set(mapOf("matrix" to matrix)))

        val snap = Tasks.await(docRef.get())
        assertEquals(matrix, snap.get("matrix"))
    }

    @Test
    fun testNestedSentinelRejectionInNonMergeSet() {
        val docRef = firestore.collection("boundary-sentinels").document("invalid-delete")
        // Direct delete sentinel without merge throws
        assertThrows(IllegalArgumentException::class.java) {
            docRef.set(mapOf("field" to FieldValue.delete()))
        }
        // Nested delete sentinel in map without merge throws
        assertThrows(IllegalArgumentException::class.java) {
            docRef.set(mapOf("nested" to mapOf("field" to FieldValue.delete())))
        }
    }
}

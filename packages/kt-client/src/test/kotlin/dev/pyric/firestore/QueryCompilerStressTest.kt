package dev.pyric.firestore

import com.google.firebase.firestore.DocumentSnapshot
import com.google.firebase.firestore.FieldPath
import com.google.firebase.firestore.Filter
import com.google.firebase.firestore.Query
import com.google.firebase.firestore.SnapshotMetadata
import dev.pyric.codecs.QueryCompiler
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertNotNull
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Assertions.assertThrows
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.BeforeEach
import org.junit.jupiter.api.DisplayName
import org.junit.jupiter.api.Nested
import org.junit.jupiter.api.Test

@DisplayName("Milestone 2 Query Compiler Validation & Defect Tests")
class QueryCompilerStressTest {

    private lateinit var harness: ConformanceMockHarness

    @BeforeEach
    fun setUp() {
        harness = ConformanceMockHarness()
    }

    private fun constraints(q: Query): List<Map<String, Any?>> {
        @Suppress("UNCHECKED_CAST")
        return (q.toTargetDescriptor()["constraints"] as? List<Map<String, Any?>>) ?: emptyList()
    }

    @Nested
    @DisplayName("Composite Filters (and / or)")
    inner class CompositeFilterTests {

        @Test
        fun `Complex nested composite filters with Filter and and Filter or`() {
            val q = harness.firestore.collection("products").where(
                Filter.and(
                    Filter.or(
                        Filter.equalTo("category", "electronics"),
                        Filter.equalTo("category", "appliances")
                    ),
                    Filter.or(
                        Filter.greaterThan("price", 100),
                        Filter.lessThan("discount", 10)
                    )
                )
            )
            val c = constraints(q)
            assertEquals(1, c.size)
            val root = c[0]
            assertEquals("and", root["kind"])
            @Suppress("UNCHECKED_CAST")
            val subFilters = root["filters"] as List<Map<String, Any?>>
            assertEquals(2, subFilters.size)

            assertEquals("or", subFilters[0]["kind"])
            @Suppress("UNCHECKED_CAST")
            val or1Filters = subFilters[0]["filters"] as List<Map<String, Any?>>
            assertEquals(2, or1Filters.size)
            assertEquals("==", or1Filters[0]["op"])
            assertEquals("category", or1Filters[0]["field"])
            assertEquals("electronics", or1Filters[0]["value"])

            assertEquals("or", subFilters[1]["kind"])
            @Suppress("UNCHECKED_CAST")
            val or2Filters = subFilters[1]["filters"] as List<Map<String, Any?>>
            assertEquals(2, or2Filters.size)
            assertEquals(">", or2Filters[0]["op"])
            assertEquals("price", or2Filters[0]["field"])
            assertEquals(100, or2Filters[0]["value"])
        }

        @Test
        fun `Composite filter with single element unrolls to unary where`() {
            val q = harness.firestore.collection("items").where(
                Filter.and(Filter.equalTo("status", "active"))
            )
            val c = constraints(q)
            assertEquals(1, c.size)
            assertEquals("where", c[0]["kind"])
            assertEquals("status", c[0]["field"])
            assertEquals("==", c[0]["op"])
            assertEquals("active", c[0]["value"])
        }

        @Test
        fun `Composite filter empty produces no constraints`() {
            val q = harness.firestore.collection("items").where(Filter.and())
            val target = q.toTargetDescriptor()
            assertEquals("collection", target["__ref"])
            assertEquals("items", target["path"])
            assertNull(target["constraints"])
        }
    }

    @Nested
    @DisplayName("Limit & LimitToLast Validations")
    inner class LimitTests {

        @Test
        fun `Query limit rejects zero and negative values`() {
            val q = harness.firestore.collection("items")
            assertThrows(IllegalArgumentException::class.java) {
                q.limit(0)
            }
            assertThrows(IllegalArgumentException::class.java) {
                q.limit(-1)
            }
            assertThrows(IllegalArgumentException::class.java) {
                q.limit(-100)
            }
        }

        @Test
        fun `Query limitToLast rejects zero and negative values`() {
            val q = harness.firestore.collection("items").orderBy("name")
            assertThrows(IllegalArgumentException::class.java) {
                q.limitToLast(0)
            }
            assertThrows(IllegalArgumentException::class.java) {
                q.limitToLast(-1)
            }
        }

        @Test
        fun `Query limitToLast without orderBy clause is rejected upon compileTarget`() {
            val q = harness.firestore.collection("items").limitToLast(10)
            val ex = assertThrows(IllegalArgumentException::class.java) {
                q.toTargetDescriptor()
            }
            assertTrue(ex.message!!.contains("limitToLast() queries require at least one orderBy clause"))
        }

        @Test
        fun `QueryCompiler compileTarget directly rejects non-positive limit values`() {
            assertThrows(IllegalArgumentException::class.java) {
                QueryCompiler.compileTarget(
                    path = "items",
                    collectionId = "items",
                    isCollectionGroup = false,
                    filters = emptyList(),
                    orderBys = emptyList(),
                    limitValue = 0L,
                    limitToLastValue = null,
                    cursors = emptyList()
                )
            }

            assertThrows(IllegalArgumentException::class.java) {
                QueryCompiler.compileTarget(
                    path = "items",
                    collectionId = "items",
                    isCollectionGroup = false,
                    filters = emptyList(),
                    orderBys = emptyList(),
                    limitValue = -5L,
                    limitToLastValue = null,
                    cursors = emptyList()
                )
            }

            assertThrows(IllegalArgumentException::class.java) {
                QueryCompiler.compileTarget(
                    path = "items",
                    collectionId = "items",
                    isCollectionGroup = false,
                    filters = emptyList(),
                    orderBys = listOf(dev.pyric.codecs.OrderBy("name", dev.pyric.codecs.Direction.ASCENDING)),
                    limitValue = null,
                    limitToLastValue = 0L,
                    cursors = emptyList()
                )
            }

            assertThrows(IllegalArgumentException::class.java) {
                QueryCompiler.compileTarget(
                    path = "items",
                    collectionId = "items",
                    isCollectionGroup = false,
                    filters = emptyList(),
                    orderBys = listOf(dev.pyric.codecs.OrderBy("name", dev.pyric.codecs.Direction.ASCENDING)),
                    limitValue = null,
                    limitToLastValue = -10L,
                    cursors = emptyList()
                )
            }
        }
    }

    @Nested
    @DisplayName("Cursor Positioning & Snapshot Extraction")
    inner class CursorTests {

        @Test
        fun `Query cursor startAt and endAt positioning with orderBy`() {
            val q = harness.firestore.collection("scores")
                .orderBy("points")
                .startAt(100)
                .endAt(500)
            val c = constraints(q)
            assertEquals(3, c.size)
            assertEquals("orderBy", c[0]["kind"])
            assertEquals("points", c[0]["field"])

            assertEquals("startAt", c[1]["kind"])
            assertEquals(listOf(100), c[1]["values"])

            assertEquals("endAt", c[2]["kind"])
            assertEquals(listOf(500), c[2]["values"])
        }

        @Test
        fun `Query orderBy called after startAt is rejected`() {
            val q = harness.firestore.collection("scores").startAt(100)
            val ex = assertThrows(IllegalArgumentException::class.java) {
                q.orderBy("points")
            }
            assertTrue(ex.message!!.contains("You must not call Query.startAt() or Query.startAfter() before calling Query.orderBy()"))
        }

        @Test
        fun `Query toTargetDescriptor rejects cursor without orderBy`() {
            val q = harness.firestore.collection("scores").startAt(100)
            val ex = assertThrows(IllegalArgumentException::class.java) {
                q.toTargetDescriptor()
            }
            assertTrue(ex.message!!.contains("You must not call Query.startAt() before calling Query.orderBy()"))
        }

        @Test
        fun `Query startAt with non-existent DocumentSnapshot throws exception`() {
            val docRef = harness.firestore.document("users/ghost")
            val nonExistentSnapshot = DocumentSnapshot(
                id = "ghost",
                reference = docRef,
                exists = false,
                rawData = null,
                metadata = SnapshotMetadata(false, false)
            )
            val q = harness.firestore.collection("users").orderBy("name")
            assertThrows(IllegalArgumentException::class.java) {
                q.startAt(nonExistentSnapshot)
            }
        }

        @Test
        fun `Query startAt with DocumentSnapshot extracts orderBy fields`() {
            val docRef = harness.firestore.document("users/alice")
            val snapshot = DocumentSnapshot(
                id = "alice",
                reference = docRef,
                exists = true,
                rawData = mapOf("age" to 30, "city" to "NY"),
                metadata = SnapshotMetadata(false, false)
            )
            val q = harness.firestore.collection("users")
                .orderBy("age")
                .orderBy("city")
                .startAt(snapshot)

            val c = constraints(q)
            val startAtCursor = c.find { it["kind"] == "startAt" }
            assertNotNull(startAtCursor)
            assertEquals(listOf(30, "NY"), startAtCursor!!["values"])
        }
    }

    @Nested
    @DisplayName("Filter Array Operator Validations")
    inner class ArrayFilterTests {

        @Test
        fun `Query filter in operator validates non-empty and max 30 elements`() {
            val coll = harness.firestore.collection("items")
            assertThrows(IllegalArgumentException::class.java) {
                coll.where(Filter.inArray("tag", emptyList<String>())).toTargetDescriptor()
            }

            val oversizedList = (1..31).toList()
            assertThrows(IllegalArgumentException::class.java) {
                coll.where(Filter.inArray("tag", oversizedList)).toTargetDescriptor()
            }
        }

        @Test
        fun `Query whereNotIn and whereArrayContainsAny reject empty lists`() {
            val coll = harness.firestore.collection("items")

            val exNotIn = assertThrows(IllegalArgumentException::class.java) {
                coll.whereNotIn("tag", emptyList<String>())
            }
            assertTrue(exNotIn.message!!.contains("A non-empty array is required for 'not-in' filters"))

            val exContainsAny = assertThrows(IllegalArgumentException::class.java) {
                coll.whereArrayContainsAny("tag", emptyList<String>())
            }
            assertTrue(exContainsAny.message!!.contains("A non-empty array is required for 'array-contains-any' filters"))

            val exIn = assertThrows(IllegalArgumentException::class.java) {
                coll.whereIn("tag", emptyList<String>())
            }
            assertTrue(exIn.message!!.contains("A non-empty array is required for 'in' filters"))
        }

        @Test
        fun `Query where with Filter notInArray and arrayContainsAny rejects empty lists`() {
            val coll = harness.firestore.collection("items")

            assertThrows(IllegalArgumentException::class.java) {
                coll.where(Filter.notInArray("tag", emptyList<String>()))
            }

            assertThrows(IllegalArgumentException::class.java) {
                coll.where(Filter.arrayContainsAny("tag", emptyList<String>()))
            }
        }

        @Test
        fun `Query filter not-in and array-contains-any validate non-empty and max 30 elements`() {
            val coll = harness.firestore.collection("items")

            assertThrows(IllegalArgumentException::class.java) {
                coll.where(Filter.notInArray("tag", emptyList<String>()))
            }
            assertThrows(IllegalArgumentException::class.java) {
                coll.where(Filter.notInArray("tag", (1..31).toList()))
            }

            assertThrows(IllegalArgumentException::class.java) {
                coll.where(Filter.arrayContainsAny("tag", emptyList<String>()))
            }
            assertThrows(IllegalArgumentException::class.java) {
                coll.where(Filter.arrayContainsAny("tag", (1..31).toList()))
            }
        }

        @Test
        fun `Query disallows array-contains and array-contains-any on FieldPath documentId`() {
            val coll = harness.firestore.collection("items")
            val ex1 = assertThrows(IllegalArgumentException::class.java) {
                coll.where(Filter.arrayContains(FieldPath.documentId(), "doc1"))
            }
            assertTrue(ex1.message!!.contains("You can't perform 'array-contains' queries on FieldPath.documentId()"))

            val ex2 = assertThrows(IllegalArgumentException::class.java) {
                coll.where(Filter.arrayContainsAny(FieldPath.documentId(), listOf("doc1", "doc2")))
            }
            assertTrue(ex2.message!!.contains("You can't perform 'array-contains-any' queries on FieldPath.documentId()"))
        }
    }
}

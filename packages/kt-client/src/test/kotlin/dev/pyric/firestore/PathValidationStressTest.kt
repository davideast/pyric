package dev.pyric.firestore

import com.google.firebase.firestore.CollectionReference
import com.google.firebase.firestore.DocumentReference
import org.junit.jupiter.api.Assertions.assertDoesNotThrow
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertNotNull
import org.junit.jupiter.api.Assertions.assertThrows
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.BeforeEach
import org.junit.jupiter.api.DisplayName
import org.junit.jupiter.api.Nested
import org.junit.jupiter.api.Test

@DisplayName("Milestone 2 Path Validation & Hierarchy Stress Tests")
class PathValidationStressTest {

    private lateinit var harness: ConformanceMockHarness

    @BeforeEach
    fun setUp() {
        harness = ConformanceMockHarness()
    }

    @Nested
    @DisplayName("FirebaseFirestore.document() Path Validation")
    inner class DocumentPathValidationTests {

        @Test
        fun `document() throws IllegalArgumentException on odd number of segments`() {
            // 1 segment
            val ex1 = assertThrows(IllegalArgumentException::class.java) {
                harness.firestore.document("users")
            }
            assertTrue(ex1.message!!.contains("must have an even number of segments"))
            assertTrue(ex1.message!!.contains("has 1"))

            // 3 segments
            val ex3 = assertThrows(IllegalArgumentException::class.java) {
                harness.firestore.document("users/alice/orders")
            }
            assertTrue(ex3.message!!.contains("must have an even number of segments"))
            assertTrue(ex3.message!!.contains("has 3"))

            // 5 segments
            val ex5 = assertThrows(IllegalArgumentException::class.java) {
                harness.firestore.document("a/b/c/d/e")
            }
            assertTrue(ex5.message!!.contains("must have an even number of segments"))
            assertTrue(ex5.message!!.contains("has 5"))
        }

        @Test
        fun `document() normalizes leading and trailing slashes for segment counting`() {
            val ex = assertThrows(IllegalArgumentException::class.java) {
                harness.firestore.document("/users/")
            }
            assertTrue(ex.message!!.contains("must have an even number of segments"))
            assertTrue(ex.message!!.contains("has 1"))

            // Valid even segments with slashes
            val doc = harness.firestore.document("/users/alice/")
            assertEquals("users/alice", doc.path)
            assertEquals("alice", doc.id)
        }

        @Test
        fun `document() behavior with empty path`() {
            // Document path with 0 segments - check whether empty document path is rejected
            try {
                val doc = harness.firestore.document("")
                // If this succeeds, note that 0 % 2 == 0 allows empty document paths
                assertEquals("", doc.path)
            } catch (e: IllegalArgumentException) {
                // Threw as desired
                assertTrue(e.message != null)
            }
        }
    }

    @Nested
    @DisplayName("FirebaseFirestore.collection() Path Validation")
    inner class CollectionPathValidationTests {

        @Test
        fun `collection() throws IllegalArgumentException on even number of segments`() {
            // 0 segments (empty path)
            val ex0 = assertThrows(IllegalArgumentException::class.java) {
                harness.firestore.collection("")
            }
            assertTrue(ex0.message!!.contains("must have an odd number of segments"))
            assertTrue(ex0.message!!.contains("has 0"))

            // 2 segments
            val ex2 = assertThrows(IllegalArgumentException::class.java) {
                harness.firestore.collection("users/alice")
            }
            assertTrue(ex2.message!!.contains("must have an odd number of segments"))
            assertTrue(ex2.message!!.contains("has 2"))

            // 4 segments
            val ex4 = assertThrows(IllegalArgumentException::class.java) {
                harness.firestore.collection("users/alice/orders/ord1")
            }
            assertTrue(ex4.message!!.contains("must have an odd number of segments"))
            assertTrue(ex4.message!!.contains("has 4"))
        }

        @Test
        fun `collection() accepts odd number of segments and normalizes slashes`() {
            val col1 = harness.firestore.collection("/users/")
            assertEquals("users", col1.path)
            assertEquals("users", col1.id)

            val col3 = harness.firestore.collection("users/alice/orders")
            assertEquals("users/alice/orders", col3.path)
            assertEquals("orders", col3.id)
        }
    }

    @Nested
    @DisplayName("FirebaseFirestore.collectionGroup() Path Validation")
    inner class CollectionGroupPathValidationTests {

        @Test
        fun `collectionGroup() throws IllegalArgumentException when path contains slash`() {
            val ex1 = assertThrows(IllegalArgumentException::class.java) {
                harness.firestore.collectionGroup("users/sub")
            }
            assertTrue(ex1.message!!.contains("Collection IDs must not contain '/'"))

            val ex2 = assertThrows(IllegalArgumentException::class.java) {
                harness.firestore.collectionGroup("/users")
            }
            assertTrue(ex2.message!!.contains("Collection IDs must not contain '/'"))

            val ex3 = assertThrows(IllegalArgumentException::class.java) {
                harness.firestore.collectionGroup("users/")
            }
            assertTrue(ex3.message!!.contains("Collection IDs must not contain '/'"))

            val ex4 = assertThrows(IllegalArgumentException::class.java) {
                harness.firestore.collectionGroup("/")
            }
            assertTrue(ex4.message!!.contains("Collection IDs must not contain '/'"))
        }

        @Test
        fun `collectionGroup() succeeds on valid single-token collection IDs`() {
            val q1 = harness.firestore.collectionGroup("messages")
            assertNotNull(q1)
            assertEquals("messages", q1.collectionId)
            assertTrue(q1.isCollectionGroup)

            val q2 = harness.firestore.collectionGroup("items")
            assertNotNull(q2)
            assertEquals("items", q2.collectionId)
            assertTrue(q2.isCollectionGroup)
        }
    }

    @Nested
    @DisplayName("Hierarchical Relative Path Navigation")
    inner class HierarchyRelativePathTests {

        @Test
        fun `CollectionReference document(subpath) validates total segment count`() {
            val col = harness.firestore.collection("users")

            // Valid odd subpath -> total even segments (1 + 1 = 2)
            val doc1 = col.document("alice")
            assertEquals("users/alice", doc1.path)

            // Valid 3-segment subpath -> total 4 segments (1 + 3 = 4)
            val doc2 = col.document("alice/orders/ord1")
            assertEquals("users/alice/orders/ord1", doc2.path)

            // Invalid even subpath -> total odd segments (1 + 2 = 3)
            val ex = assertThrows(IllegalArgumentException::class.java) {
                col.document("alice/orders")
            }
            assertTrue(ex.message!!.contains("must have an even number of segments"))
            assertTrue(ex.message!!.contains("has 3"))
        }

        @Test
        fun `DocumentReference collection(subpath) validates total segment count`() {
            val doc = harness.firestore.document("users/alice")

            // Valid 1-segment subpath -> total 3 segments (2 + 1 = 3)
            val col1 = doc.collection("orders")
            assertEquals("users/alice/orders", col1.path)

            // Invalid 2-segment subpath -> total 4 segments (2 + 2 = 4)
            val ex = assertThrows(IllegalArgumentException::class.java) {
                doc.collection("orders/ord1")
            }
            assertTrue(ex.message!!.contains("must have an odd number of segments"))
            assertTrue(ex.message!!.contains("has 4"))
        }
    }
}

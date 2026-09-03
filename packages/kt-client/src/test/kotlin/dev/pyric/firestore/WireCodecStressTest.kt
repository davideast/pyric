package dev.pyric.firestore

import com.google.firebase.Timestamp
import com.google.firebase.firestore.Blob
import com.google.firebase.firestore.GeoPoint
import dev.pyric.codecs.Base64Url
import dev.pyric.codecs.ValueCodec
import org.junit.jupiter.api.Assertions.assertArrayEquals
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertNotEquals
import org.junit.jupiter.api.Assertions.assertThrows
import org.junit.jupiter.api.DisplayName
import org.junit.jupiter.api.Nested
import org.junit.jupiter.api.Test
import java.util.Date

@DisplayName("Milestone 2 Wire Codec Boundary & Robustness Tests")
class WireCodecStressTest {

    // ── 1. Timestamp Tests ────────────────────────────────────────────────────

    @Nested
    @DisplayName("Timestamp Boundary & Pre-1970 Handling")
    inner class TimestampBoundaries {

        @Test
        fun `Timestamp accepts negative seconds and zero nanoseconds`() {
            val ts = Timestamp(-100L, 0)
            assertEquals(-100L, ts.seconds)
            assertEquals(0, ts.nanoseconds)

            val encoded = ValueCodec.encodeValue(ts) as Map<*, *>
            assertEquals("timestamp", encoded["__type"])
            assertEquals(-100L, encoded["seconds"])
            assertEquals(0, encoded["nanos"])

            val decoded = ValueCodec.decodeValue(encoded) as Timestamp
            assertEquals(ts, decoded)
        }

        @Test
        fun `Timestamp accepts exact minimum and maximum seconds boundaries`() {
            // Min: 0001-01-01T00:00:00Z -> -62135596800L
            val minTs = Timestamp(-62135596800L, 0)
            assertEquals(-62135596800L, minTs.seconds)

            // Max: 9999-12-31T23:59:59Z -> 253402300799L
            val maxTs = Timestamp(253402300799L, 999999999)
            assertEquals(253402300799L, maxTs.seconds)
            assertEquals(999999999, maxTs.nanoseconds)
        }

        @Test
        fun `Timestamp rejects out-of-bounds seconds`() {
            assertThrows(IllegalArgumentException::class.java) {
                Timestamp(-62135596801L, 0)
            }
            assertThrows(IllegalArgumentException::class.java) {
                Timestamp(253402300800L, 0)
            }
        }

        @Test
        fun `Timestamp nanoseconds boundary and out-of-bounds rejection`() {
            val tsZeroNanos = Timestamp(0L, 0)
            assertEquals(0, tsZeroNanos.nanoseconds)
            val tsMaxNanos = Timestamp(0L, 999999999)
            assertEquals(999999999, tsMaxNanos.nanoseconds)

            assertThrows(IllegalArgumentException::class.java) {
                Timestamp(0L, -1)
            }
            assertThrows(IllegalArgumentException::class.java) {
                Timestamp(0L, 1000000000)
            }
        }

        @Test
        fun `Timestamp Date constructor correctly handles pre-1970 fractional milliseconds`() {
            // 500ms before Unix Epoch: 1969-12-31T23:59:59.500Z (-500ms)
            // True value: seconds = -1L, nanoseconds = 500_000_000
            val date = Date(-500L)
            val ts = Timestamp(date)

            assertEquals(-1L, ts.seconds)
            assertEquals(500000000, ts.nanoseconds)
            assertEquals(date.time, ts.toDate().time)
            assertEquals(date, ts.toDate())

            // Boundary test: exact second boundary (-1000ms)
            val exactSec = Date(-1000L)
            val tsExact = Timestamp(exactSec)
            assertEquals(-1L, tsExact.seconds)
            assertEquals(0, tsExact.nanoseconds)
            assertEquals(exactSec, tsExact.toDate())

            // Boundary test: -1001ms
            val preSec = Date(-1001L)
            val tsPre = Timestamp(preSec)
            assertEquals(-2L, tsPre.seconds)
            assertEquals(999000000, tsPre.nanoseconds)
            assertEquals(preSec, tsPre.toDate())
        }

        @Test
        fun `ValueCodec decodes wire timestamp with invalid nanos fails validation`() {
            val invalidWire = mapOf(
                "__type" to "timestamp",
                "seconds" to 100L,
                "nanos" to -5
            )
            assertThrows(IllegalArgumentException::class.java) {
                ValueCodec.decodeValue(invalidWire)
            }
        }
    }

    // ── 2. GeoPoint Tests ─────────────────────────────────────────────────────

    @Nested
    @DisplayName("GeoPoint Boundary & Out-of-Bounds Handling")
    inner class GeoPointBoundaries {

        @Test
        fun `GeoPoint boundary latitudes -90 and 90 are accepted`() {
            val p1 = GeoPoint(-90.0, 0.0)
            assertEquals(-90.0, p1.latitude)

            val p2 = GeoPoint(90.0, 0.0)
            assertEquals(90.0, p2.latitude)
        }

        @Test
        fun `GeoPoint out-of-bounds latitudes are rejected`() {
            assertThrows(IllegalArgumentException::class.java) {
                GeoPoint(-90.0001, 0.0)
            }
            assertThrows(IllegalArgumentException::class.java) {
                GeoPoint(90.0001, 0.0)
            }
            assertThrows(IllegalArgumentException::class.java) {
                GeoPoint(Double.NaN, 0.0)
            }
            assertThrows(IllegalArgumentException::class.java) {
                GeoPoint(Double.POSITIVE_INFINITY, 0.0)
            }
            assertThrows(IllegalArgumentException::class.java) {
                GeoPoint(Double.NEGATIVE_INFINITY, 0.0)
            }
        }

        @Test
        fun `GeoPoint boundary longitudes -180 and 180 are accepted`() {
            val p1 = GeoPoint(0.0, -180.0)
            assertEquals(-180.0, p1.longitude)

            val p2 = GeoPoint(0.0, 180.0)
            assertEquals(180.0, p2.longitude)
        }

        @Test
        fun `GeoPoint out-of-bounds longitudes are rejected`() {
            assertThrows(IllegalArgumentException::class.java) {
                GeoPoint(0.0, -180.0001)
            }
            assertThrows(IllegalArgumentException::class.java) {
                GeoPoint(0.0, 180.0001)
            }
            assertThrows(IllegalArgumentException::class.java) {
                GeoPoint(0.0, Double.NaN)
            }
            assertThrows(IllegalArgumentException::class.java) {
                GeoPoint(0.0, Double.POSITIVE_INFINITY)
            }
            assertThrows(IllegalArgumentException::class.java) {
                GeoPoint(0.0, Double.NEGATIVE_INFINITY)
            }
        }

        @Test
        fun `GeoPoint wire roundtrip`() {
            val point = GeoPoint(-90.0, 180.0)
            val encoded = ValueCodec.encodeValue(point) as Map<*, *>
            assertEquals("latlng", encoded["__type"])
            assertEquals(-90.0, encoded["lat"])
            assertEquals(180.0, encoded["lng"])

            val decoded = ValueCodec.decodeValue(encoded) as GeoPoint
            assertEquals(point, decoded)
        }
    }

    // ── 3. Blob Tests ─────────────────────────────────────────────────────────

    @Nested
    @DisplayName("Blob Unpadded Base64Url Encoding")
    inner class BlobBoundaries {

        @Test
        fun `Blob unpadded base64url encoding produces no padding character`() {
            for (len in 1..5) {
                val bytes = ByteArray(len) { it.toByte() }
                val encoded = Base64Url.encodeUnpadded(bytes)
                assertFalse(encoded.contains("="), "Base64Url unpadded must not contain '=' for length $len: $encoded")
                val decoded = Base64Url.decodeUnpadded(encoded)
                assertArrayEquals(bytes, decoded, "Decoded bytes must match original for length $len")
            }
        }

        @Test
        fun `Blob base64url maps URL-unsafe characters plus to minus and slash to underscore`() {
            // 0xF8: standard Base64 is '+A==', base64url is '-A'
            val plusBytes = byteArrayOf(0xF8.toByte())
            val encodedPlus = Base64Url.encodeUnpadded(plusBytes)
            assertEquals("-A", encodedPlus)
            assertFalse(encodedPlus.contains("+"))
            assertFalse(encodedPlus.contains("="))

            // 0xFC: standard Base64 is '/A==', base64url is '_A'
            val slashBytes = byteArrayOf(0xFC.toByte())
            val encodedSlash = Base64Url.encodeUnpadded(slashBytes)
            assertEquals("_A", encodedSlash)
            assertFalse(encodedSlash.contains("/"))
            assertFalse(encodedSlash.contains("="))

            // 0xFF, 0xFF, 0xBE: standard Base64 is '//++', base64url is '__--'
            val comboBytes = byteArrayOf(0xFF.toByte(), 0xFF.toByte(), 0xBE.toByte())
            val encodedCombo = Base64Url.encodeUnpadded(comboBytes)
            assertEquals("__--", encodedCombo)
            assertArrayEquals(comboBytes, Base64Url.decodeUnpadded(encodedCombo))
        }

        @Test
        fun `Blob wire codec roundtrip`() {
            val blob = Blob.fromBytes(byteArrayOf(0xF8.toByte(), 0xFC.toByte()))
            val encoded = ValueCodec.encodeValue(blob) as Map<*, *>
            assertEquals("bytes", encoded["__type"])
            val b64 = encoded["base64"] as String
            assertFalse(b64.contains("="))
            assertFalse(b64.contains("+"))
            assertFalse(b64.contains("/"))

            val decoded = ValueCodec.decodeValue(encoded) as Blob
            assertArrayEquals(blob.toBytes(), decoded.toBytes())
        }
    }
}

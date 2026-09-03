package com.google.firebase.firestore

/**
 * An immutable object representing a geographical point (latitude and longitude) in Firestore.
 */
class GeoPoint(val latitude: Double, val longitude: Double) : Comparable<GeoPoint> {

    init {
        require(!latitude.isNaN() && latitude in -90.0..90.0) {
            "Latitude must be in the range of [-90, 90]"
        }
        require(!longitude.isNaN() && longitude in -180.0..180.0) {
            "Longitude must be in the range of [-180, 180]"
        }
    }

    override fun compareTo(other: GeoPoint): Int {
        val latCmp = latitude.compareTo(other.latitude)
        return if (latCmp != 0) latCmp else longitude.compareTo(other.longitude)
    }

    override fun equals(other: Any?): Boolean {
        if (this === other) return true
        if (other !is GeoPoint) return false
        return latitude.compareTo(other.latitude) == 0 && longitude.compareTo(other.longitude) == 0
    }

    override fun hashCode(): Int {
        var result = latitude.hashCode()
        result = 31 * result + longitude.hashCode()
        return result
    }

    override fun toString(): String {
        return "GeoPoint(latitude=$latitude, longitude=$longitude)"
    }
}

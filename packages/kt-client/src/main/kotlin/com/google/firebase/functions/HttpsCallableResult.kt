package com.google.firebase.functions

class HttpsCallableResult(
    val data: Any?
) {
    override fun equals(other: Any?): Boolean {
        if (this === other) return true
        if (other !is HttpsCallableResult) return false
        return data == other.data
    }

    override fun hashCode(): Int = data?.hashCode() ?: 0

    override fun toString(): String = "HttpsCallableResult(data=$data)"
}

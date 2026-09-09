package com.google.firebase.auth

abstract class AuthCredential internal constructor(
    open val provider: String
) {
    internal abstract fun toWireMap(): Map<String, Any?>
}

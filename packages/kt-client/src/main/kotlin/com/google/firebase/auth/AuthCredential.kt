package com.google.firebase.auth

abstract class AuthCredential internal constructor(
    open val provider: String
) {
    abstract val signInMethod: String

    internal abstract fun toWireMap(): Map<String, Any?>
}

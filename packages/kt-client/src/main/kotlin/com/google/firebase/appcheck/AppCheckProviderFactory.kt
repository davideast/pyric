package com.google.firebase.appcheck

import com.google.firebase.FirebaseApp

fun interface AppCheckProviderFactory {
    fun create(firebaseApp: FirebaseApp): AppCheckProvider
}

package com.google.firebase.firestore

fun interface EventListener<T> {
    fun onEvent(value: T?, error: FirebaseFirestoreException?)
}

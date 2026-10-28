package com.google.firebase.auth

import com.google.firebase.Firebase
import com.google.firebase.FirebaseApp

/** `Firebase.auth`, compiled as `com.google.firebase.auth.AuthKt.getAuth`, as in firebase-auth. */
val Firebase.auth: FirebaseAuth
    get() = FirebaseAuth.getInstance()

fun Firebase.auth(app: FirebaseApp): FirebaseAuth =
    FirebaseAuth.getInstance(app)

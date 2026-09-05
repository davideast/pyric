package com.google.firebase.auth

import java.net.URI

interface UserInfo {
    val uid: String
    val email: String?
    val displayName: String?
    val photoUrl: URI?
    val phoneNumber: String?
    val providerId: String
    val isEmailVerified: Boolean
}

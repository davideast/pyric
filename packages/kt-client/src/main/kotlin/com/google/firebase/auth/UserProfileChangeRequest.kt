package com.google.firebase.auth

import java.net.URI

class UserProfileChangeRequest private constructor(
    val displayName: String?,
    val photoUri: URI?
) {
    class Builder {
        private var displayName: String? = null
        private var photoUri: URI? = null

        fun setDisplayName(displayName: String?): Builder {
            this.displayName = displayName
            return this
        }

        fun setPhotoUri(uri: URI?): Builder {
            this.photoUri = uri
            return this
        }

        fun setPhotoUri(uriString: String?): Builder {
            this.photoUri = uriString?.let { runCatching { URI.create(it) }.getOrNull() }
            return this
        }

        fun build(): UserProfileChangeRequest = UserProfileChangeRequest(displayName, photoUri)
    }
}

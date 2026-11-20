package com.google.firebase.auth

import java.net.URI

class UserProfileChangeRequest private constructor(
    val displayName: String?,
    val photoUri: URI?,
    internal val displayNameSet: Boolean = false,
    internal val photoUriSet: Boolean = false
) {
    class Builder {
        private var displayName: String? = null
        private var photoUri: URI? = null
        private var displayNameSet: Boolean = false
        private var photoUriSet: Boolean = false

        fun setDisplayName(displayName: String?): Builder {
            this.displayName = displayName
            this.displayNameSet = true
            return this
        }

        fun setPhotoUri(uri: URI?): Builder {
            this.photoUri = uri
            this.photoUriSet = true
            return this
        }

        fun setPhotoUri(uriString: String?): Builder {
            this.photoUri = uriString?.let { runCatching { URI.create(it) }.getOrNull() }
            this.photoUriSet = true
            return this
        }

        fun build(): UserProfileChangeRequest =
            UserProfileChangeRequest(displayName, photoUri, displayNameSet, photoUriSet)
    }
}

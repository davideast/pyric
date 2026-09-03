package com.google.firebase

class FirebaseOptions(
    val projectId: String,
    val apiKey: String,
    val applicationId: String,
    val databaseUrl: String? = null,
    val gaTrackingId: String? = null,
    val gcmSenderId: String? = null,
    val storageBucket: String? = null
) {
    class Builder {
        private var projectId: String = ""
        private var apiKey: String = ""
        private var applicationId: String = ""
        private var databaseUrl: String? = null
        private var gaTrackingId: String? = null
        private var gcmSenderId: String? = null
        private var storageBucket: String? = null

        fun setProjectId(projectId: String): Builder = apply { this.projectId = projectId }
        fun setApiKey(apiKey: String): Builder = apply { this.apiKey = apiKey }
        fun setApplicationId(applicationId: String): Builder = apply { this.applicationId = applicationId }
        fun setDatabaseUrl(databaseUrl: String?): Builder = apply { this.databaseUrl = databaseUrl }
        fun setGaTrackingId(gaTrackingId: String?): Builder = apply { this.gaTrackingId = gaTrackingId }
        fun setGcmSenderId(gcmSenderId: String?): Builder = apply { this.gcmSenderId = gcmSenderId }
        fun setStorageBucket(storageBucket: String?): Builder = apply { this.storageBucket = storageBucket }

        fun build(): FirebaseOptions = FirebaseOptions(
            projectId = projectId,
            apiKey = apiKey,
            applicationId = applicationId,
            databaseUrl = databaseUrl,
            gaTrackingId = gaTrackingId,
            gcmSenderId = gcmSenderId,
            storageBucket = storageBucket
        )
    }
}

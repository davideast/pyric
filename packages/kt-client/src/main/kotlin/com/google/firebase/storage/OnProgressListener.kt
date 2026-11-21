package com.google.firebase.storage

fun interface OnProgressListener<ProgressT> {
    fun onProgress(snapshot: ProgressT)
}
